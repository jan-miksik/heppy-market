// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IMockPerpDEX {
    function openPosition(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice)
        external returns (uint256 positionId);
    function closePosition(uint256 positionId, uint256 acceptablePrice)
        external returns (int256 pnl);
    function collateralToken() external view returns (address);
}

/// @title Agent
/// @notice Multi-agent vault with delegated execution permissions.
/// @dev Designed as a secure onchain execution layer for autonomous perpetual trading agents.
///
/// Security property: the contract trusts the executor's collateral valuation
/// (it is a delegated-execution risk limit, not a price oracle). The executor is
/// responsible for supplying values consistent with what the user authorized in
/// setDelegatedExecutorApproval.
contract Agent {
    struct AgentState {
        address owner;
        bytes metadata;
        uint256 nativeBalance;
        bool exists;
        bool delegatedExecutionEnabled;
        bool paused;
        uint8 maxLeverage; // 1–10, default 10
    }

    struct DelegatedExecutorApproval {
        bool canTick;
        bool canTrade;
        uint128 maxTradeNotionalValueWei;    // 0 = unlimited (max collateral per trade)
        uint128 dailyTradeNotionalLimitWei;  // 0 = unlimited (daily collateral limit)
        uint64 dayIndex;
        uint128 notionalSpentTodayWei;
    }

    uint256 public nextAgentId = 1;

    mapping(uint256 => AgentState) private _agents;
    mapping(address => uint256[]) private _ownerAgentIds;
    mapping(uint256 => mapping(address => uint256)) private _tokenBalances;
    mapping(uint256 => mapping(address => DelegatedExecutorApproval)) private _delegatedExecutorApprovals;
    /// @dev Per-agent allowlisted perp DEX addresses
    mapping(uint256 => mapping(address => bool)) private _allowedPerpDexes;
    /// @dev Per-agent token allowlist (collateral tokens)
    mapping(uint256 => mapping(address => bool)) private _allowedTradeTokens;
    /// @dev Per-agent open perp position IDs (agentId => positionId[])
    mapping(uint256 => uint256[]) private _openPositionIds;

    uint256 private _reentrancyState = 1;

    event AgentCreated(uint256 indexed agentId, address indexed owner, bytes metadata, uint256 timestamp);
    event MetadataUpdated(uint256 indexed agentId, bytes metadata);
    event DelegatedExecutionUpdated(uint256 indexed agentId, bool enabled);
    event AgentPaused(uint256 indexed agentId, bool paused);
    event MaxLeverageUpdated(uint256 indexed agentId, uint8 maxLeverage);

    event NativeDeposited(uint256 indexed agentId, address indexed from, uint256 amount, uint256 newBalance);
    event NativeWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount, uint256 newBalance);
    event TokenDeposited(uint256 indexed agentId, address indexed token, address indexed from, uint256 amount, uint256 newBalance);
    event TokenWithdrawn(uint256 indexed agentId, address indexed token, address indexed to, uint256 amount, uint256 newBalance);

    event AllowedPerpDexSet(uint256 indexed agentId, address indexed perpDexAddress, bool allowed);
    event AllowedTradeTokenSet(uint256 indexed agentId, address indexed tokenAddress, bool allowed);
    event DelegatedExecutorApprovalSet(
        uint256 indexed agentId,
        address indexed executor,
        bool canTick,
        bool canTrade,
        uint128 maxTradeNotionalValueWei,
        uint128 dailyTradeNotionalLimitWei
    );
    event DelegatedExecutorRevoked(uint256 indexed agentId, address indexed executor);

    event TickExecuted(uint256 indexed agentId, address indexed caller, uint256 timestamp);
    event PerpPositionOpened(
        uint256 indexed agentId,
        address indexed delegatedExecutor,
        address indexed perpDexAddress,
        bytes32 market,
        bool isLong,
        uint256 collateralAmount,
        uint256 leverage,
        uint256 perpPositionId,
        uint256 executionDeadline
    );
    event PerpPositionClosed(
        uint256 indexed agentId,
        address indexed delegatedExecutor,
        address indexed perpDexAddress,
        uint256 perpPositionId,
        int256 pnl,
        uint256 executionDeadline
    );

    event NativeReceived(address indexed from, uint256 amount);

    error AgentNotFound(uint256 agentId);
    error NotAgentOwner(uint256 agentId, address caller);
    error NotAuthorizedTickExecutor(uint256 agentId, address caller);
    error NotAuthorizedTradeExecutor(uint256 agentId, address caller);
    error DelegatedExecutionDisabled(uint256 agentId);
    error AgentIsPaused(uint256 agentId);
    error ZeroAddress();
    error ZeroAmount();
    error PerpDexNotAllowed(uint256 agentId, address perpDexAddress);
    error TradeTokenNotAllowed(uint256 agentId, address tokenAddress);
    error InsufficientNativeBalance(uint256 agentId, uint256 requested, uint256 available);
    error InsufficientTokenBalance(uint256 agentId, address token, uint256 requested, uint256 available);
    error TradeNotionalLimitExceeded(uint256 agentId, address executor, uint256 attempted, uint256 limit);
    error DailyTradeNotionalLimitExceeded(uint256 agentId, address executor, uint256 attemptedTotal, uint256 dailyLimit);
    error InvalidLeverage(uint256 requested, uint256 max);
    error ExternalCallFailed(bytes reason);
    error ERC20QueryFailed(address token);
    error ERC20OperationFailed(address token);
    error Reentrancy();
    error ExecutionPlanExpired(uint256 executionDeadline, uint256 nowTs);
    error PerpPositionNotTracked(uint256 agentId, uint256 perpPositionId);

    modifier nonReentrant() {
        if (_reentrancyState != 1) revert Reentrancy();
        _reentrancyState = 2;
        _;
        _reentrancyState = 1;
    }

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    // ─────────────────────────── Agent Lifecycle ───────────────────────────

    /// @notice Create a new agent vault owned by msg.sender.
    function createAgent(bytes calldata metadata) external returns (uint256 agentId) {
        agentId = nextAgentId;
        unchecked {
            nextAgentId = agentId + 1;
        }

        _agents[agentId] = AgentState({
            owner: msg.sender,
            metadata: metadata,
            nativeBalance: 0,
            exists: true,
            delegatedExecutionEnabled: false,
            paused: false,
            maxLeverage: 10
        });
        _ownerAgentIds[msg.sender].push(agentId);
        emit AgentCreated(agentId, msg.sender, metadata, block.timestamp);
    }

    function ownerAgentIds(address owner) external view returns (uint256[] memory) {
        return _ownerAgentIds[owner];
    }

    function getAgent(uint256 agentId)
        external
        view
        returns (
            address owner,
            bytes memory metadata,
            uint256 nativeBalance,
            bool exists,
            bool delegatedExecutionEnabled,
            bool paused
        )
    {
        AgentState storage a = _agents[agentId];
        return (a.owner, a.metadata, a.nativeBalance, a.exists, a.delegatedExecutionEnabled, a.paused);
    }

    function hasAgent(uint256 agentId) external view returns (bool) {
        return _agents[agentId].exists;
    }

    function getMaxLeverage(uint256 agentId) external view returns (uint8) {
        return _agents[agentId].maxLeverage;
    }

    // ─────────────────────────── Deposits / Withdrawals ───────────────────────────

    function depositNative(uint256 agentId) external payable {
        AgentState storage a = _requireOwner(agentId);
        if (msg.value == 0) revert ZeroAmount();
        a.nativeBalance += msg.value;
        emit NativeDeposited(agentId, msg.sender, msg.value, a.nativeBalance);
    }

    function withdrawNative(uint256 agentId, uint256 amount, address payable to) external nonReentrant {
        AgentState storage a = _requireOwner(agentId);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (a.nativeBalance < amount) revert InsufficientNativeBalance(agentId, amount, a.nativeBalance);

        a.nativeBalance -= amount;
        (bool ok, bytes memory ret) = to.call{value: amount}("");
        if (!ok) revert ExternalCallFailed(ret);
        emit NativeWithdrawn(agentId, to, amount, a.nativeBalance);
    }

    function depositToken(uint256 agentId, address token, uint256 amount) external nonReentrant {
        _requireOwner(agentId);
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _safeTransferFrom(token, msg.sender, address(this), amount);
        _tokenBalances[agentId][token] += amount;
        emit TokenDeposited(agentId, token, msg.sender, amount, _tokenBalances[agentId][token]);
    }

    function withdrawToken(uint256 agentId, address token, uint256 amount, address to) external nonReentrant {
        _requireOwner(agentId);
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 balance = _tokenBalances[agentId][token];
        if (balance < amount) revert InsufficientTokenBalance(agentId, token, amount, balance);

        _tokenBalances[agentId][token] = balance - amount;
        _safeTransfer(token, to, amount);
        emit TokenWithdrawn(agentId, token, to, amount, _tokenBalances[agentId][token]);
    }

    function tokenBalance(uint256 agentId, address token) external view returns (uint256) {
        return _tokenBalances[agentId][token];
    }

    // ─────────────────────────── Configuration ───────────────────────────

    function updateMetadata(uint256 agentId, bytes calldata metadata) external {
        AgentState storage a = _requireOwner(agentId);
        a.metadata = metadata;
        emit MetadataUpdated(agentId, metadata);
    }

    function setDelegatedExecutionEnabled(uint256 agentId, bool enabled) external {
        AgentState storage a = _requireOwner(agentId);
        a.delegatedExecutionEnabled = enabled;
        emit DelegatedExecutionUpdated(agentId, enabled);
    }

    function setPaused(uint256 agentId, bool paused) external {
        AgentState storage a = _requireOwner(agentId);
        a.paused = paused;
        emit AgentPaused(agentId, paused);
    }

    function setMaxLeverage(uint256 agentId, uint8 maxLev) external {
        _requireOwner(agentId);
        if (maxLev == 0 || maxLev > 10) revert InvalidLeverage(maxLev, 10);
        _agents[agentId].maxLeverage = maxLev;
        emit MaxLeverageUpdated(agentId, maxLev);
    }

    /// @notice Allowlist or remove a perp DEX address for an agent.
    function setAllowedPerpDex(uint256 agentId, address perpDexAddress, bool allowed) external {
        _requireOwner(agentId);
        if (perpDexAddress == address(0)) revert ZeroAddress();
        _allowedPerpDexes[agentId][perpDexAddress] = allowed;
        emit AllowedPerpDexSet(agentId, perpDexAddress, allowed);
    }

    function isPerpDexAllowed(uint256 agentId, address perpDexAddress) external view returns (bool) {
        return _allowedPerpDexes[agentId][perpDexAddress];
    }

    /// @notice Allowlist or remove a trade token (collateral).
    function setAllowedTradeToken(uint256 agentId, address tokenAddress, bool allowed) external {
        _requireOwner(agentId);
        if (tokenAddress == address(0)) revert ZeroAddress();
        _allowedTradeTokens[agentId][tokenAddress] = allowed;
        emit AllowedTradeTokenSet(agentId, tokenAddress, allowed);
    }

    function isTradeTokenAllowed(uint256 agentId, address tokenAddress) external view returns (bool) {
        return _allowedTradeTokens[agentId][tokenAddress];
    }

    // ─────────────────────────── Delegation ───────────────────────────

    function setDelegatedExecutorApproval(
        uint256 agentId,
        address executor,
        bool canTick,
        bool canTrade,
        uint128 maxTradeNotionalValueWei,
        uint128 dailyTradeNotionalLimitWei
    ) external {
        _requireOwner(agentId);
        if (executor == address(0)) revert ZeroAddress();

        DelegatedExecutorApproval storage approval = _delegatedExecutorApprovals[agentId][executor];
        approval.canTick = canTick;
        approval.canTrade = canTrade;
        approval.maxTradeNotionalValueWei = maxTradeNotionalValueWei;
        approval.dailyTradeNotionalLimitWei = dailyTradeNotionalLimitWei;

        if (!canTrade) {
            approval.dayIndex = 0;
            approval.notionalSpentTodayWei = 0;
        }

        emit DelegatedExecutorApprovalSet(
            agentId, executor, canTick, canTrade, maxTradeNotionalValueWei, dailyTradeNotionalLimitWei
        );
    }

    function revokeDelegatedExecutor(uint256 agentId, address executor) external {
        _requireOwner(agentId);
        delete _delegatedExecutorApprovals[agentId][executor];
        emit DelegatedExecutorRevoked(agentId, executor);
    }

    function getDelegatedExecutorApproval(uint256 agentId, address executor)
        external
        view
        returns (
            bool canTick,
            bool canTrade,
            uint128 maxTradeNotionalValueWei,
            uint128 dailyTradeNotionalLimitWei,
            uint64 dayIndex,
            uint128 notionalSpentTodayWei
        )
    {
        DelegatedExecutorApproval storage approval = _delegatedExecutorApprovals[agentId][executor];
        uint64 today = _todayIndex();
        uint128 currentSpent = approval.dayIndex == today ? approval.notionalSpentTodayWei : 0;
        return (
            approval.canTick,
            approval.canTrade,
            approval.maxTradeNotionalValueWei,
            approval.dailyTradeNotionalLimitWei,
            approval.dayIndex,
            currentSpent
        );
    }

    // ─────────────────────────── Execution ───────────────────────────

    /// @notice Execution anchor for one analysis tick.
    function executeTick(uint256 agentId) external {
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);
        _requireTickPermission(agentId, a, msg.sender);
        emit TickExecuted(agentId, msg.sender, block.timestamp);
    }

    /// @notice Open a perpetual position using the agent's collateral token balance.
    /// @param agentId           Agent vault to trade from.
    /// @param perpDexAddress    Address of the MockPerpDEX.
    /// @param market            Market identifier hash (e.g., keccak256("BTC/USD")).
    /// @param isLong            True for long, false for short.
    /// @param collateralAmount  Collateral to commit from the vault.
    /// @param leverage          Leverage multiplier (1–maxLeverage).
    /// @param acceptablePrice   Slippage guard passed to the perp DEX.
    /// @param executionDeadline Unix timestamp after which the call reverts.
    function executePerpOpen(
        uint256 agentId,
        address perpDexAddress,
        bytes32 market,
        bool isLong,
        uint256 collateralAmount,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 executionDeadline
    ) external nonReentrant returns (uint256 perpPositionId) {
        // 1. Agent must exist and not be paused.
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);

        // 2. Deadline check.
        if (block.timestamp > executionDeadline) revert ExecutionPlanExpired(executionDeadline, block.timestamp);

        // 3. Perp DEX allowlist.
        if (perpDexAddress == address(0)) revert ZeroAddress();
        if (!_allowedPerpDexes[agentId][perpDexAddress]) revert PerpDexNotAllowed(agentId, perpDexAddress);

        // 4. Leverage check.
        if (leverage == 0 || leverage > a.maxLeverage) revert InvalidLeverage(leverage, a.maxLeverage);

        // 5. Amount sanity.
        if (collateralAmount == 0) revert ZeroAmount();

        // 6. Resolve collateral token from the perp DEX.
        address collateralToken = IMockPerpDEX(perpDexAddress).collateralToken();
        if (!_allowedTradeTokens[agentId][collateralToken]) revert TradeTokenNotAllowed(agentId, collateralToken);

        // 7. Sufficient vault balance.
        uint256 vaultBal = _tokenBalances[agentId][collateralToken];
        if (vaultBal < collateralAmount) {
            revert InsufficientTokenBalance(agentId, collateralToken, collateralAmount, vaultBal);
        }

        // 8. Delegated execution checks (owner can always trade; non-owner needs delegation).
        if (msg.sender != a.owner) {
            if (!a.delegatedExecutionEnabled) revert DelegatedExecutionDisabled(agentId);
            _consumeTradeNotionalAllowance(agentId, a, msg.sender, collateralAmount);
        }

        // 9. Debit vault, approve perp DEX, and open position.
        _tokenBalances[agentId][collateralToken] = vaultBal - collateralAmount;

        _safeApprove(collateralToken, perpDexAddress, 0);
        _safeApprove(collateralToken, perpDexAddress, collateralAmount);

        perpPositionId = IMockPerpDEX(perpDexAddress).openPosition(
            market, isLong, collateralAmount, leverage, acceptablePrice
        );

        _safeApprove(collateralToken, perpDexAddress, 0);

        // 10. Track position.
        _openPositionIds[agentId].push(perpPositionId);

        emit PerpPositionOpened(
            agentId,
            msg.sender,
            perpDexAddress,
            market,
            isLong,
            collateralAmount,
            leverage,
            perpPositionId,
            executionDeadline
        );
    }

    /// @notice Close a perpetual position and credit returned collateral (+/- P&L) to the vault.
    /// @param agentId           Agent vault that owns the position.
    /// @param perpDexAddress    Address of the MockPerpDEX.
    /// @param perpPositionId    Position ID to close.
    /// @param acceptablePrice   Slippage guard passed to the perp DEX.
    /// @param executionDeadline Unix timestamp after which the call reverts.
    function executePerpClose(
        uint256 agentId,
        address perpDexAddress,
        uint256 perpPositionId,
        uint256 acceptablePrice,
        uint256 executionDeadline
    ) external nonReentrant returns (int256 pnl) {
        // 1. Agent must exist and not be paused.
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);

        // 2. Deadline check.
        if (block.timestamp > executionDeadline) revert ExecutionPlanExpired(executionDeadline, block.timestamp);

        // 3. Perp DEX allowlist.
        if (perpDexAddress == address(0)) revert ZeroAddress();
        if (!_allowedPerpDexes[agentId][perpDexAddress]) revert PerpDexNotAllowed(agentId, perpDexAddress);

        // 4. Verify position is tracked by this agent.
        _removeTrackedPosition(agentId, perpPositionId);

        // 5. Delegated execution checks.
        if (msg.sender != a.owner) {
            if (!a.delegatedExecutionEnabled) revert DelegatedExecutionDisabled(agentId);
            DelegatedExecutorApproval storage approval = _delegatedExecutorApprovals[agentId][msg.sender];
            if (!approval.canTrade) revert NotAuthorizedTradeExecutor(agentId, msg.sender);
        }

        // 6. Resolve collateral token.
        address collateralToken = IMockPerpDEX(perpDexAddress).collateralToken();

        // 7. Record balance before close to measure returned amount.
        uint256 balBefore = _erc20Balance(collateralToken, address(this));

        pnl = IMockPerpDEX(perpDexAddress).closePosition(perpPositionId, acceptablePrice);

        uint256 balAfter = _erc20Balance(collateralToken, address(this));
        uint256 returned = balAfter > balBefore ? balAfter - balBefore : 0;

        // 8. Credit returned collateral to the vault.
        _tokenBalances[agentId][collateralToken] += returned;

        emit PerpPositionClosed(
            agentId, msg.sender, perpDexAddress, perpPositionId, pnl, executionDeadline
        );
    }

    /// @notice Returns the list of open perp position IDs for an agent.
    function getOpenPositionIds(uint256 agentId) external view returns (uint256[] memory) {
        return _openPositionIds[agentId];
    }

    // ─────────────────────────── Internal ───────────────────────────

    function _requireAgent(uint256 agentId) private view returns (AgentState storage a) {
        a = _agents[agentId];
        if (!a.exists) revert AgentNotFound(agentId);
    }

    function _requireOwner(uint256 agentId) private view returns (AgentState storage a) {
        a = _requireAgent(agentId);
        if (a.owner != msg.sender) revert NotAgentOwner(agentId, msg.sender);
    }

    function _requireTickPermission(uint256 agentId, AgentState storage a, address caller) private view {
        if (caller == a.owner) return;
        if (!a.delegatedExecutionEnabled) revert DelegatedExecutionDisabled(agentId);
        DelegatedExecutorApproval storage approval = _delegatedExecutorApprovals[agentId][caller];
        if (!approval.canTick) revert NotAuthorizedTickExecutor(agentId, caller);
    }

    function _consumeTradeNotionalAllowance(
        uint256 agentId,
        AgentState storage a,
        address caller,
        uint256 tradeNotionalValueWei
    ) private {
        if (caller == a.owner) return;

        DelegatedExecutorApproval storage approval = _delegatedExecutorApprovals[agentId][caller];
        if (!approval.canTrade) revert NotAuthorizedTradeExecutor(agentId, caller);

        uint256 maxPerTrade = approval.maxTradeNotionalValueWei;
        if (maxPerTrade != 0 && tradeNotionalValueWei > maxPerTrade) {
            revert TradeNotionalLimitExceeded(agentId, caller, tradeNotionalValueWei, maxPerTrade);
        }

        uint64 today = _todayIndex();
        if (approval.dayIndex != today) {
            approval.dayIndex = today;
            approval.notionalSpentTodayWei = 0;
        }

        uint256 attemptedTotal = uint256(approval.notionalSpentTodayWei) + tradeNotionalValueWei;
        uint256 dailyLimit = approval.dailyTradeNotionalLimitWei;
        if (dailyLimit != 0 && attemptedTotal > dailyLimit) {
            revert DailyTradeNotionalLimitExceeded(agentId, caller, attemptedTotal, dailyLimit);
        }
        if (attemptedTotal > type(uint128).max) {
            revert DailyTradeNotionalLimitExceeded(agentId, caller, attemptedTotal, type(uint128).max);
        }

        approval.notionalSpentTodayWei = uint128(attemptedTotal);
    }

    function _removeTrackedPosition(uint256 agentId, uint256 perpPositionId) private {
        uint256[] storage ids = _openPositionIds[agentId];
        uint256 len = ids.length;
        for (uint256 i = 0; i < len; i++) {
            if (ids[i] == perpPositionId) {
                ids[i] = ids[len - 1];
                ids.pop();
                return;
            }
        }
        revert PerpPositionNotTracked(agentId, perpPositionId);
    }

    function _todayIndex() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    function _erc20Balance(address token, address account) private view returns (uint256 bal) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20Like.balanceOf, (account)));
        if (!ok || ret.length < 32) revert ERC20QueryFailed(token);
        bal = abi.decode(ret, (uint256));
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Like.transferFrom, (from, to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert ERC20OperationFailed(token);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Like.transfer, (to, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert ERC20OperationFailed(token);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Like.approve, (spender, amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert ERC20OperationFailed(token);
    }
}
