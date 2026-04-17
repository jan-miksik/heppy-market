// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title MockPerpDEX
/// @notice Simulated perpetual futures DEX for hackathon demo.
/// @dev Positions are tracked internally with configurable mark prices.
///      The contract owner sets prices via `updatePrice()` (replaces oracle).
///      P&L is calculated on close using the difference between entry and exit price.
contract MockPerpDEX {
    struct Position {
        address account;
        bytes32 market;
        bool isLong;
        uint256 collateralAmount;   // collateral token units
        uint256 leverage;           // 1-based (e.g., 5 = 5x)
        uint256 size;               // collateral * leverage (notional)
        uint256 entryPrice;         // 18-decimal fixed-point
        bool open;
    }

    address public owner;
    address public collateralToken;   // iUSD-demo

    uint256 public nextPositionId = 1;

    mapping(bytes32 => uint256) public markPrices;   // market hash → 18-decimal price
    mapping(uint256 => Position) public positions;

    event PositionOpened(
        uint256 indexed positionId,
        address indexed account,
        bytes32 indexed market,
        bool isLong,
        uint256 collateralAmount,
        uint256 leverage,
        uint256 size,
        uint256 entryPrice
    );
    event PositionClosed(
        uint256 indexed positionId,
        address indexed account,
        uint256 exitPrice,
        int256 pnl,
        uint256 returnedCollateral
    );
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed liquidator,
        uint256 markPrice
    );
    event PriceUpdated(bytes32 indexed market, uint256 oldPrice, uint256 newPrice);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidLeverage(uint256 leverage, uint256 maxLeverage);
    error PositionNotFound(uint256 positionId);
    error PositionAlreadyClosed(uint256 positionId);
    error NotPositionOwner(uint256 positionId, address caller);
    error PriceNotSet(bytes32 market);
    error SlippageExceeded(uint256 acceptablePrice, uint256 markPrice);
    error NotLiquidatable(uint256 positionId);
    error TransferFailed();

    uint256 public constant MAX_LEVERAGE = 10;
    /// @dev Liquidation threshold: position is liquidatable when losses exceed 90% of collateral
    uint256 private constant LIQUIDATION_THRESHOLD_BPS = 9000;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address collateralToken_) {
        if (collateralToken_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        collateralToken = collateralToken_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    /// @notice Set / update the mark price for a market. Owner-only (replaces oracle).
    function updatePrice(bytes32 market, uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert ZeroAmount();
        uint256 old = markPrices[market];
        markPrices[market] = newPrice;
        emit PriceUpdated(market, old, newPrice);
    }

    /// @notice Open a perpetual position. Collateral is transferred into this contract.
    /// @param market      Hashed market identifier (e.g., keccak256("BTC/USD"))
    /// @param isLong      True for long, false for short
    /// @param collateral  Amount of collateral token to deposit
    /// @param leverage    Leverage multiplier (1–MAX_LEVERAGE)
    /// @param acceptablePrice  Slippage guard: max price for longs, min price for shorts
    function openPosition(
        bytes32 market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptablePrice
    ) external returns (uint256 positionId) {
        if (collateral == 0) revert ZeroAmount();
        if (leverage == 0 || leverage > MAX_LEVERAGE) revert InvalidLeverage(leverage, MAX_LEVERAGE);

        uint256 price = markPrices[market];
        if (price == 0) revert PriceNotSet(market);

        // Slippage check
        if (isLong && price > acceptablePrice) revert SlippageExceeded(acceptablePrice, price);
        if (!isLong && price < acceptablePrice) revert SlippageExceeded(acceptablePrice, price);

        // Transfer collateral in
        bool ok = IERC20Like(collateralToken).transferFrom(msg.sender, address(this), collateral);
        if (!ok) revert TransferFailed();

        positionId = nextPositionId;
        unchecked { nextPositionId = positionId + 1; }

        uint256 size = collateral * leverage;

        positions[positionId] = Position({
            account: msg.sender,
            market: market,
            isLong: isLong,
            collateralAmount: collateral,
            leverage: leverage,
            size: size,
            entryPrice: price,
            open: true
        });

        emit PositionOpened(positionId, msg.sender, market, isLong, collateral, leverage, size, price);
    }

    /// @notice Close an open position. P&L is calculated and collateral (+/- P&L) returned.
    function closePosition(uint256 positionId, uint256 acceptablePrice) external returns (int256 pnl) {
        Position storage pos = _requireOpen(positionId);
        if (pos.account != msg.sender) revert NotPositionOwner(positionId, msg.sender);

        uint256 exitPrice = markPrices[pos.market];
        if (exitPrice == 0) revert PriceNotSet(pos.market);

        // Slippage check for close
        if (pos.isLong && exitPrice < acceptablePrice) revert SlippageExceeded(acceptablePrice, exitPrice);
        if (!pos.isLong && exitPrice > acceptablePrice) revert SlippageExceeded(acceptablePrice, exitPrice);

        pnl = _calculatePnl(pos, exitPrice);
        uint256 returnAmount = _settlePosition(pos, pnl);

        pos.open = false;

        if (returnAmount > 0) {
            bool ok = IERC20Like(collateralToken).transfer(pos.account, returnAmount);
            if (!ok) revert TransferFailed();
        }

        emit PositionClosed(positionId, pos.account, exitPrice, pnl, returnAmount);
    }

    /// @notice Liquidate an underwater position. Anyone can call this.
    function liquidatePosition(uint256 positionId) external {
        Position storage pos = _requireOpen(positionId);

        uint256 currentPrice = markPrices[pos.market];
        if (currentPrice == 0) revert PriceNotSet(pos.market);

        int256 pnl = _calculatePnl(pos, currentPrice);

        // Check if losses exceed liquidation threshold (90% of collateral)
        int256 threshold = -int256((pos.collateralAmount * LIQUIDATION_THRESHOLD_BPS) / 10000);
        if (pnl > threshold) revert NotLiquidatable(positionId);

        pos.open = false;

        // Liquidated position: remaining collateral (if any) stays in the contract
        // In production this would go to an insurance fund
        emit PositionLiquidated(positionId, msg.sender, currentPrice);
    }

    /// @notice Read position details.
    function getPosition(uint256 positionId)
        external
        view
        returns (
            address account,
            bytes32 market,
            bool isLong,
            uint256 collateralAmount,
            uint256 leverage,
            uint256 size,
            uint256 entryPrice,
            bool open_
        )
    {
        Position storage pos = positions[positionId];
        return (
            pos.account,
            pos.market,
            pos.isLong,
            pos.collateralAmount,
            pos.leverage,
            pos.size,
            pos.entryPrice,
            pos.open
        );
    }

    /// @notice Calculate unrealized P&L for an open position at current mark price.
    function unrealizedPnl(uint256 positionId) external view returns (int256) {
        Position storage pos = positions[positionId];
        if (!pos.open) return int256(0);
        uint256 currentPrice = markPrices[pos.market];
        if (currentPrice == 0) return int256(0);
        return _calculatePnl(pos, currentPrice);
    }

    /// @dev P&L = size * (exitPrice - entryPrice) / entryPrice for longs (negated for shorts)
    ///      Result is in collateral token units.
    function _calculatePnl(Position storage pos, uint256 exitPrice) private view returns (int256) {
        // pnl = collateral * leverage * (exit - entry) / entry  [for longs]
        // pnl = collateral * leverage * (entry - exit) / entry  [for shorts]
        if (pos.entryPrice == 0) return 0;

        int256 priceDelta;
        if (pos.isLong) {
            priceDelta = int256(exitPrice) - int256(pos.entryPrice);
        } else {
            priceDelta = int256(pos.entryPrice) - int256(exitPrice);
        }

        // pnl = (collateral * leverage * priceDelta) / entryPrice
        return (int256(pos.collateralAmount) * int256(pos.leverage) * priceDelta) / int256(pos.entryPrice);
    }

    /// @dev Calculate return amount: collateral + pnl, clamped to [0, collateral + abs(pnl)]
    function _settlePosition(Position storage pos, int256 pnl) private view returns (uint256) {
        if (pnl >= 0) {
            return pos.collateralAmount + uint256(pnl);
        } else {
            uint256 loss = uint256(-pnl);
            if (loss >= pos.collateralAmount) return 0;
            return pos.collateralAmount - loss;
        }
    }

    function _requireOpen(uint256 positionId) private view returns (Position storage pos) {
        pos = positions[positionId];
        if (pos.account == address(0)) revert PositionNotFound(positionId);
        if (!pos.open) revert PositionAlreadyClosed(positionId);
    }
}
