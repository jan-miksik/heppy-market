// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title Agent
/// @notice Multi-agent vault with delegated execution permissions.
/// @dev Designed as a secure onchain execution layer for autonomous trading agents.
contract Agent {
    struct AgentState {
        address owner;
        bytes metadata;
        uint256 nativeBalance;
        bool exists;
        bool autoSignEnabled;
        bool paused;
    }

    struct ExecutorApproval {
        bool canTick;
        bool canTrade;
        uint128 maxValuePerTradeWei; // 0 = unlimited
        uint128 dailyLimitWei;       // 0 = unlimited
        uint64 dayIndex;
        uint128 spentTodayWei;
    }

    uint256 public nextAgentId = 1;

    mapping(uint256 => AgentState) private _agents;
    mapping(address => uint256[]) private _ownerAgentIds;
    mapping(uint256 => mapping(address => uint256)) private _tokenBalances;
    mapping(uint256 => mapping(address => ExecutorApproval)) private _executorApprovals;
    mapping(uint256 => mapping(address => bool)) private _allowedTargets;

    uint256 private _reentrancyState = 1;

    event AgentCreated(uint256 indexed agentId, address indexed owner, bytes metadata, uint256 timestamp);
    event MetadataUpdated(uint256 indexed agentId, bytes metadata);
    event AutoSignUpdated(uint256 indexed agentId, bool enabled);
    event AgentPaused(uint256 indexed agentId, bool paused);

    event NativeDeposited(uint256 indexed agentId, address indexed from, uint256 amount, uint256 newBalance);
    event NativeWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount, uint256 newBalance);
    event TokenDeposited(uint256 indexed agentId, address indexed token, address indexed from, uint256 amount, uint256 newBalance);
    event TokenWithdrawn(uint256 indexed agentId, address indexed token, address indexed to, uint256 amount, uint256 newBalance);

    event AllowedTargetSet(uint256 indexed agentId, address indexed target, bool allowed);
    event ExecutorApprovalSet(
        uint256 indexed agentId,
        address indexed executor,
        bool canTick,
        bool canTrade,
        uint128 maxValuePerTradeWei,
        uint128 dailyLimitWei
    );
    event ExecutorRevoked(uint256 indexed agentId, address indexed executor);

    event TickExecuted(uint256 indexed agentId, address indexed caller, uint256 timestamp);
    event TradeCallExecuted(
        uint256 indexed agentId,
        address indexed executor,
        address indexed target,
        uint256 nativeValue,
        bytes32 callDataHash
    );
    event TokenTradeExecuted(
        uint256 indexed agentId,
        address indexed executor,
        address indexed target,
        address tokenIn,
        address tokenOut,
        uint256 amountInRequested,
        uint256 amountInSpent,
        uint256 amountOutReceived,
        uint256 nativeValue
    );

    event NativeReceived(address indexed from, uint256 amount);

    error AgentNotFound(uint256 agentId);
    error NotAgentOwner(uint256 agentId, address caller);
    error NotAuthorizedTickExecutor(uint256 agentId, address caller);
    error NotAuthorizedTradeExecutor(uint256 agentId, address caller);
    error AutoSignDisabled(uint256 agentId);
    error AgentIsPaused(uint256 agentId);
    error ZeroAddress();
    error ZeroAmount();
    error TargetNotAllowed(uint256 agentId, address target);
    error InsufficientNativeBalance(uint256 agentId, uint256 requested, uint256 available);
    error InsufficientTokenBalance(uint256 agentId, address token, uint256 requested, uint256 available);
    error TradeValueLimitExceeded(uint256 agentId, address executor, uint256 attempted, uint256 maxPerTrade);
    error DailyTradeValueLimitExceeded(uint256 agentId, address executor, uint256 attemptedTotal, uint256 dailyLimit);
    error InvalidTokenPair(address tokenIn, address tokenOut);
    error SlippageExceeded(uint256 minAmountOut, uint256 actualAmountOut);
    error ExternalCallFailed(bytes reason);
    error NativeAccountingInvariant();
    error ERC20QueryFailed(address token);
    error ERC20OperationFailed(address token);
    error Reentrancy();

    modifier nonReentrant() {
        if (_reentrancyState != 1) revert Reentrancy();
        _reentrancyState = 2;
        _;
        _reentrancyState = 1;
    }

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

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
            autoSignEnabled: false,
            paused: false
        });
        _ownerAgentIds[msg.sender].push(agentId);
        emit AgentCreated(agentId, msg.sender, metadata, block.timestamp);
    }

    /// @notice Returns the list of agent IDs owned by `owner`.
    function ownerAgentIds(address owner) external view returns (uint256[] memory) {
        return _ownerAgentIds[owner];
    }

    /// @notice Returns full agent state.
    function getAgent(uint256 agentId)
        external
        view
        returns (
            address owner,
            bytes memory metadata,
            uint256 nativeBalance,
            bool exists,
            bool autoSignEnabled,
            bool paused
        )
    {
        AgentState storage a = _agents[agentId];
        return (a.owner, a.metadata, a.nativeBalance, a.exists, a.autoSignEnabled, a.paused);
    }

    function hasAgent(uint256 agentId) external view returns (bool) {
        return _agents[agentId].exists;
    }

    /// @notice Deposit native GAS into a specific agent vault.
    function depositNative(uint256 agentId) external payable {
        AgentState storage a = _requireOwner(agentId);
        if (msg.value == 0) revert ZeroAmount();
        a.nativeBalance += msg.value;
        emit NativeDeposited(agentId, msg.sender, msg.value, a.nativeBalance);
    }

    /// @notice Withdraw native GAS from a specific agent vault.
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

    /// @notice Deposit ERC-20 token balance into a specific agent vault.
    function depositToken(uint256 agentId, address token, uint256 amount) external nonReentrant {
        _requireOwner(agentId);
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _safeTransferFrom(token, msg.sender, address(this), amount);
        _tokenBalances[agentId][token] += amount;
        emit TokenDeposited(agentId, token, msg.sender, amount, _tokenBalances[agentId][token]);
    }

    /// @notice Withdraw ERC-20 token balance from a specific agent vault.
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

    function updateMetadata(uint256 agentId, bytes calldata metadata) external {
        AgentState storage a = _requireOwner(agentId);
        a.metadata = metadata;
        emit MetadataUpdated(agentId, metadata);
    }

    function setAutoSignEnabled(uint256 agentId, bool enabled) external {
        AgentState storage a = _requireOwner(agentId);
        a.autoSignEnabled = enabled;
        emit AutoSignUpdated(agentId, enabled);
    }

    function setPaused(uint256 agentId, bool paused) external {
        AgentState storage a = _requireOwner(agentId);
        a.paused = paused;
        emit AgentPaused(agentId, paused);
    }

    function setAllowedTarget(uint256 agentId, address target, bool allowed) external {
        _requireOwner(agentId);
        if (target == address(0)) revert ZeroAddress();
        _allowedTargets[agentId][target] = allowed;
        emit AllowedTargetSet(agentId, target, allowed);
    }

    function isTargetAllowed(uint256 agentId, address target) external view returns (bool) {
        return _allowedTargets[agentId][target];
    }

    /// @notice Configure delegated execution permissions for one agent.
    function setExecutorApproval(
        uint256 agentId,
        address executor,
        bool canTick,
        bool canTrade,
        uint128 maxValuePerTradeWei,
        uint128 dailyLimitWei
    ) external {
        _requireOwner(agentId);
        if (executor == address(0)) revert ZeroAddress();

        ExecutorApproval storage approval = _executorApprovals[agentId][executor];
        approval.canTick = canTick;
        approval.canTrade = canTrade;
        approval.maxValuePerTradeWei = maxValuePerTradeWei;
        approval.dailyLimitWei = dailyLimitWei;

        if (!canTrade) {
            approval.dayIndex = 0;
            approval.spentTodayWei = 0;
        }

        emit ExecutorApprovalSet(
            agentId,
            executor,
            canTick,
            canTrade,
            maxValuePerTradeWei,
            dailyLimitWei
        );
    }

    function revokeExecutor(uint256 agentId, address executor) external {
        _requireOwner(agentId);
        delete _executorApprovals[agentId][executor];
        emit ExecutorRevoked(agentId, executor);
    }

    function getExecutorApproval(uint256 agentId, address executor)
        external
        view
        returns (
            bool canTick,
            bool canTrade,
            uint128 maxValuePerTradeWei,
            uint128 dailyLimitWei,
            uint64 dayIndex,
            uint128 spentTodayWei
        )
    {
        ExecutorApproval storage approval = _executorApprovals[agentId][executor];
        uint64 today = _todayIndex();
        uint128 currentSpent = approval.dayIndex == today ? approval.spentTodayWei : 0;
        return (
            approval.canTick,
            approval.canTrade,
            approval.maxValuePerTradeWei,
            approval.dailyLimitWei,
            approval.dayIndex,
            currentSpent
        );
    }

    /// @notice Execution anchor for one analysis tick.
    function executeTick(uint256 agentId) external {
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);
        _requireTickPermission(agentId, a, msg.sender);
        emit TickExecuted(agentId, msg.sender, block.timestamp);
    }

    /// @notice Execute an allowed external call using the agent's native balance.
    function executeTradeCall(
        uint256 agentId,
        address target,
        uint256 nativeValue,
        bytes calldata callData
    ) external nonReentrant returns (bytes memory returnData) {
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);
        if (target == address(0)) revert ZeroAddress();
        if (!_allowedTargets[agentId][target]) revert TargetNotAllowed(agentId, target);
        if (a.nativeBalance < nativeValue) revert InsufficientNativeBalance(agentId, nativeValue, a.nativeBalance);

        _consumeTradeAllowance(agentId, a, msg.sender, nativeValue);

        uint256 nativeBefore = address(this).balance;
        if (nativeBefore < nativeValue) revert NativeAccountingInvariant();

        a.nativeBalance -= nativeValue;

        (bool ok, bytes memory data) = target.call{value: nativeValue}(callData);
        if (!ok) revert ExternalCallFailed(data);
        returnData = data;

        uint256 expectedAfter = nativeBefore - nativeValue;
        uint256 nativeAfter = address(this).balance;
        if (nativeAfter < expectedAfter) revert NativeAccountingInvariant();

        // Credit any native refund back into the same agent vault.
        if (nativeAfter > expectedAfter) {
            uint256 refunded = nativeAfter - expectedAfter;
            a.nativeBalance += refunded;
        }

        emit TradeCallExecuted(agentId, msg.sender, target, nativeValue, keccak256(callData));
    }

    /// @notice Execute an allowed external call that spends agent ERC-20 balance.
    function executeTokenTrade(
        uint256 agentId,
        address target,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 nativeValue,
        bytes calldata callData
    ) external nonReentrant returns (uint256 amountInSpent, uint256 amountOutReceived, bytes memory returnData) {
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);
        if (target == address(0) || tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert InvalidTokenPair(tokenIn, tokenOut);
        if (amountIn == 0) revert ZeroAmount();
        if (!_allowedTargets[agentId][target]) revert TargetNotAllowed(agentId, target);
        if (a.nativeBalance < nativeValue) revert InsufficientNativeBalance(agentId, nativeValue, a.nativeBalance);

        uint256 vaultTokenIn = _tokenBalances[agentId][tokenIn];
        if (vaultTokenIn < amountIn) revert InsufficientTokenBalance(agentId, tokenIn, amountIn, vaultTokenIn);

        _consumeTradeAllowance(agentId, a, msg.sender, nativeValue);

        uint256 nativeBefore = address(this).balance;
        if (nativeBefore < nativeValue) revert NativeAccountingInvariant();

        uint256 tokenInBefore = _erc20Balance(tokenIn, address(this));
        uint256 tokenOutBefore = _erc20Balance(tokenOut, address(this));

        _tokenBalances[agentId][tokenIn] = vaultTokenIn - amountIn;
        a.nativeBalance -= nativeValue;

        _safeApprove(tokenIn, target, 0);
        _safeApprove(tokenIn, target, amountIn);

        (bool ok, bytes memory data) = target.call{value: nativeValue}(callData);
        _safeApprove(tokenIn, target, 0);

        if (!ok) revert ExternalCallFailed(data);
        returnData = data;

        uint256 expectedAfter = nativeBefore - nativeValue;
        uint256 nativeAfter = address(this).balance;
        if (nativeAfter < expectedAfter) revert NativeAccountingInvariant();
        if (nativeAfter > expectedAfter) {
            uint256 refunded = nativeAfter - expectedAfter;
            a.nativeBalance += refunded;
        }

        uint256 tokenInAfter = _erc20Balance(tokenIn, address(this));
        uint256 tokenOutAfter = _erc20Balance(tokenOut, address(this));

        if (tokenInAfter > tokenInBefore) {
            uint256 refundedIn = tokenInAfter - tokenInBefore;
            _tokenBalances[agentId][tokenIn] += refundedIn;
            amountInSpent = amountIn > refundedIn ? amountIn - refundedIn : 0;
        } else {
            amountInSpent = tokenInBefore - tokenInAfter;
            if (amountInSpent > amountIn) revert NativeAccountingInvariant();
        }

        amountOutReceived = tokenOutAfter > tokenOutBefore ? tokenOutAfter - tokenOutBefore : 0;
        if (amountOutReceived < minAmountOut) revert SlippageExceeded(minAmountOut, amountOutReceived);

        _tokenBalances[agentId][tokenOut] += amountOutReceived;

        emit TokenTradeExecuted(
            agentId,
            msg.sender,
            target,
            tokenIn,
            tokenOut,
            amountIn,
            amountInSpent,
            amountOutReceived,
            nativeValue
        );
    }

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
        if (!a.autoSignEnabled) revert AutoSignDisabled(agentId);
        ExecutorApproval storage approval = _executorApprovals[agentId][caller];
        if (!approval.canTick) revert NotAuthorizedTickExecutor(agentId, caller);
    }

    function _consumeTradeAllowance(
        uint256 agentId,
        AgentState storage a,
        address caller,
        uint256 valueWei
    ) private {
        if (caller == a.owner) return;
        if (!a.autoSignEnabled) revert AutoSignDisabled(agentId);

        ExecutorApproval storage approval = _executorApprovals[agentId][caller];
        if (!approval.canTrade) revert NotAuthorizedTradeExecutor(agentId, caller);

        uint256 maxPerTrade = approval.maxValuePerTradeWei;
        if (maxPerTrade != 0 && valueWei > maxPerTrade) {
            revert TradeValueLimitExceeded(agentId, caller, valueWei, maxPerTrade);
        }

        uint64 today = _todayIndex();
        if (approval.dayIndex != today) {
            approval.dayIndex = today;
            approval.spentTodayWei = 0;
        }

        uint256 attemptedTotal = uint256(approval.spentTodayWei) + valueWei;
        uint256 dailyLimit = approval.dailyLimitWei;
        if (dailyLimit != 0 && attemptedTotal > dailyLimit) {
            revert DailyTradeValueLimitExceeded(agentId, caller, attemptedTotal, dailyLimit);
        }
        if (attemptedTotal > type(uint128).max) {
            revert DailyTradeValueLimitExceeded(agentId, caller, attemptedTotal, type(uint128).max);
        }

        approval.spentTodayWei = uint128(attemptedTotal);
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
