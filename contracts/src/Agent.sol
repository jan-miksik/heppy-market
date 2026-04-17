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
    function getPosition(uint256 positionId)
        external view returns (
            address account,
            bytes32 market,
            bool isLong,
            uint256 collateralAmount,
            uint256 leverage,
            uint256 size,
            uint256 entryPrice,
            bool open_
        );
}

/// @title Agent
/// @notice Multi-agent vault with delegated execution permissions.
/// @dev Designed as a secure onchain execution layer for autonomous perpetual trading agents.
///
/// Security property: the contract trusts the executor's collateral valuation
/// (it is a delegated-execution risk limit, not a price oracle). The executor is
/// responsible for supplying values consistent with what the user authorized in
/// setDelegatedExecutorApproval.
///
/// @dev ERC-20 tokens sent directly to this contract (not via depositToken) are NOT
/// credited to any agent vault and cannot be withdrawn. Use depositToken exclusively.
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
        uint128 maxTradeNotionalValueWei;    // 0 = unlimited; enforces collateral × leverage per trade
        uint128 dailyTradeNotionalLimitWei;  // 0 = unlimited; enforces daily collateral × leverage total
        uint64 dayIndex;
        uint128 notionalSpentTodayWei;
    }

    /// @notice A perp position tracked by an agent, namespaced by the DEX that issued it.
    /// @dev Position IDs are only unique within a single DEX; different DEXes can independently
    ///      mint the same numeric ID. This struct binds them together so cross-DEX calls are safe.
    struct TrackedPosition {
        address perpDex;
        uint256 positionId;
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
    /// @dev Per-agent open perp positions, namespaced by (perpDex, positionId) to avoid cross-DEX ID collisions.
    mapping(uint256 => TrackedPosition[]) private _openPositions;
    /// @dev Index-plus-one into _openPositions for O(1) removal. 0 means "not tracked".
    ///      Key: keccak256(abi.encode(perpDex, positionId)).
    mapping(uint256 => mapping(bytes32 => uint256)) private _positionIndexPlusOne;
    /// @dev Global cache of each DEX's collateralToken(), populated on first allowlist.
    ///      Avoids re-querying the (trusted) DEX on every trade. Never cleared — multiple
    ///      agents may share a DEX, and the collateral token is treated as immutable.
    mapping(address => address) private _perpDexCollateralToken;

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
    event PositionPruned(uint256 indexed agentId, address indexed perpDexAddress, uint256 perpPositionId);

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
    error PositionStillOpen(uint256 agentId, uint256 perpPositionId);
    error DirectNativeTransferDisabled();

    modifier nonReentrant() {
        if (_reentrancyState != 1) revert Reentrancy();
        _reentrancyState = 2;
        _;
        _reentrancyState = 1;
    }

    receive() external payable {
        revert DirectNativeTransferDisabled();
    }

    // ─────────────────────────── Agent Lifecycle ───────────────────────────

    /// @notice Create a new agent vault owned by msg.sender.
    function createAgent(bytes calldata metadata) external returns (uint256 agentId) {
        agentId = _createAgent(metadata, false);
    }

    /// @notice Create a new agent vault and optionally enable delegated execution immediately.
    function createAgentWithDelegatedExecution(bytes calldata metadata, bool delegatedExecutionEnabled)
        external
        returns (uint256 agentId)
    {
        agentId = _createAgent(metadata, delegatedExecutionEnabled);
    }

    function _createAgent(bytes calldata metadata, bool delegatedExecutionEnabled) internal returns (uint256 agentId) {
        agentId = nextAgentId;
        unchecked {
            nextAgentId = agentId + 1;
        }

        _agents[agentId] = AgentState({
            owner: msg.sender,
            metadata: metadata,
            nativeBalance: 0,
            exists: true,
            delegatedExecutionEnabled: delegatedExecutionEnabled,
            paused: false,
            maxLeverage: 10
        });
        _ownerAgentIds[msg.sender].push(agentId);
        emit AgentCreated(agentId, msg.sender, metadata, block.timestamp);
        if (delegatedExecutionEnabled) {
            emit DelegatedExecutionUpdated(agentId, true);
        }
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
    /// @dev TRUST BOUNDARY: allowlisting a perp DEX authorizes it to receive any collateral token
    ///      allowlisted by this agent via `setAllowedTradeToken`. The caller is responsible for
    ///      vetting the DEX implementation — a malicious DEX can drain all approved collateral by
    ///      returning arbitrary values from `collateralToken()` or mishandling transferred funds.
    ///      On first allowlist of a given DEX (across all agents), this contract queries
    ///      `collateralToken()` once and caches the result. The cache is never cleared, so
    ///      agents sharing a DEX share a single query cost.
    function setAllowedPerpDex(uint256 agentId, address perpDexAddress, bool allowed) external {
        _requireOwner(agentId);
        if (perpDexAddress == address(0)) revert ZeroAddress();
        _allowedPerpDexes[agentId][perpDexAddress] = allowed;
        if (allowed && _perpDexCollateralToken[perpDexAddress] == address(0)) {
            address token = IMockPerpDEX(perpDexAddress).collateralToken();
            if (token == address(0)) revert ZeroAddress();
            _perpDexCollateralToken[perpDexAddress] = token;
        }
        emit AllowedPerpDexSet(agentId, perpDexAddress, allowed);
    }

    function isPerpDexAllowed(uint256 agentId, address perpDexAddress) external view returns (bool) {
        return _allowedPerpDexes[agentId][perpDexAddress];
    }

    /// @notice Cached collateral token for an allowlisted DEX. Returns address(0) if never allowlisted.
    function perpDexCollateralToken(address perpDexAddress) external view returns (address) {
        return _perpDexCollateralToken[perpDexAddress];
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

        // 6. Resolve collateral token from the cached mapping (populated at allowlist time).
        address collateralToken = _perpDexCollateralToken[perpDexAddress];
        if (!_allowedTradeTokens[agentId][collateralToken]) revert TradeTokenNotAllowed(agentId, collateralToken);

        // 7. Sufficient vault balance.
        uint256 vaultBal = _tokenBalances[agentId][collateralToken];
        if (vaultBal < collateralAmount) {
            revert InsufficientTokenBalance(agentId, collateralToken, collateralAmount, vaultBal);
        }

        // 8. Delegated execution checks (owner can always trade; non-owner needs delegation).
        if (msg.sender != a.owner) {
            if (!a.delegatedExecutionEnabled) revert DelegatedExecutionDisabled(agentId);
            // leverage is validated 1–maxLeverage (≤10) above, so multiplication cannot overflow uint256
            _consumeTradeNotionalAllowance(agentId, a, msg.sender, collateralAmount * leverage);
        }

        // 9. Debit vault, approve perp DEX, and open position.
        _tokenBalances[agentId][collateralToken] = vaultBal - collateralAmount;

        _safeApprove(collateralToken, perpDexAddress, 0);
        _safeApprove(collateralToken, perpDexAddress, collateralAmount);

        perpPositionId = IMockPerpDEX(perpDexAddress).openPosition(
            market, isLong, collateralAmount, leverage, acceptablePrice
        );

        _safeApprove(collateralToken, perpDexAddress, 0);

        // 10. Track position, namespaced by (perpDex, positionId).
        _trackPosition(agentId, perpDexAddress, perpPositionId);

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
    /// @dev Closes intentionally do not consume the daily notional allowance; only opens do.
    ///      This asymmetry is by design — closes return funds and should not be throttled.
    ///      A malicious allowlisted DEX combined with open/close cycling could extract funds
    ///      bounded only by the per-trade open limit.
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

        // 4. Verify position is tracked by this agent under the given DEX (collision-safe).
        _removeTrackedPosition(agentId, perpDexAddress, perpPositionId);

        // 5. Delegated execution checks.
        if (msg.sender != a.owner) {
            if (!a.delegatedExecutionEnabled) revert DelegatedExecutionDisabled(agentId);
            DelegatedExecutorApproval storage approval = _delegatedExecutorApprovals[agentId][msg.sender];
            if (!approval.canTrade) revert NotAuthorizedTradeExecutor(agentId, msg.sender);
        }

        // 6. Resolve collateral token from the cached mapping.
        address collateralToken = _perpDexCollateralToken[perpDexAddress];

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

    /// @notice Returns the list of open perp positions for an agent, each paired with its DEX.
    function getOpenPositions(uint256 agentId) external view returns (TrackedPosition[] memory) {
        return _openPositions[agentId];
    }

    /// @notice Remove a locally tracked position that was externally liquidated on the DEX.
    /// @dev No funds are moved. Reverts if the position is still open at the DEX, or not tracked
    ///      under the specified DEX (collision-safe: pruning with the wrong DEX address fails).
    function pruneClosedPosition(uint256 agentId, address perpDex, uint256 positionId) external nonReentrant {
        _requireOwner(agentId);
        if (perpDex == address(0)) revert ZeroAddress();
        if (!_allowedPerpDexes[agentId][perpDex]) revert PerpDexNotAllowed(agentId, perpDex);

        (,,,,,,, bool open_) = IMockPerpDEX(perpDex).getPosition(positionId);
        if (open_) revert PositionStillOpen(agentId, positionId);

        _removeTrackedPosition(agentId, perpDex, positionId);
        emit PositionPruned(agentId, perpDex, positionId);
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

    function _positionKey(address perpDex, uint256 positionId) private pure returns (bytes32) {
        return keccak256(abi.encode(perpDex, positionId));
    }

    function _trackPosition(uint256 agentId, address perpDex, uint256 perpPositionId) private {
        bytes32 key = _positionKey(perpDex, perpPositionId);
        // perpPositionIds come from nextPositionId on each DEX and are unique per DEX, so a
        // (perpDex, positionId) pair cannot collide with any previously tracked entry.
        TrackedPosition[] storage positions = _openPositions[agentId];
        positions.push(TrackedPosition({perpDex: perpDex, positionId: perpPositionId}));
        _positionIndexPlusOne[agentId][key] = positions.length; // index+1
    }

    function _removeTrackedPosition(uint256 agentId, address perpDex, uint256 perpPositionId) private {
        bytes32 key = _positionKey(perpDex, perpPositionId);
        uint256 indexPlusOne = _positionIndexPlusOne[agentId][key];
        if (indexPlusOne == 0) revert PerpPositionNotTracked(agentId, perpPositionId);

        TrackedPosition[] storage positions = _openPositions[agentId];
        uint256 idx = indexPlusOne - 1;
        uint256 lastIdx = positions.length - 1;

        if (idx != lastIdx) {
            TrackedPosition memory moved = positions[lastIdx];
            positions[idx] = moved;
            _positionIndexPlusOne[agentId][_positionKey(moved.perpDex, moved.positionId)] = idx + 1;
        }
        positions.pop();
        delete _positionIndexPlusOne[agentId][key];
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
