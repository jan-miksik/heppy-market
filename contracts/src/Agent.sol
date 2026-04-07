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
/// @dev Designed as a secure onchain execution layer for autonomous spot trading agents.
///
/// Security property: the contract trusts the executor's tradeNotionalValueWei valuation
/// (it is a delegated-execution risk limit, not a price oracle). The executor is
/// responsible for supplying a value consistent with what the user authorized in
/// setDelegatedExecutorApproval.
contract Agent {
    struct AgentState {
        address owner;
        bytes metadata;
        uint256 nativeBalance;
        bool exists;
        bool delegatedExecutionEnabled;
        bool paused;
    }

    struct DelegatedExecutorApproval {
        bool canTick;
        bool canTrade;
        uint128 maxTradeNotionalValueWei;    // 0 = unlimited
        uint128 dailyTradeNotionalLimitWei;  // 0 = unlimited
        uint64 dayIndex;
        uint128 notionalSpentTodayWei;
    }

    uint256 public nextAgentId = 1;

    mapping(uint256 => AgentState) private _agents;
    mapping(address => uint256[]) private _ownerAgentIds;
    mapping(uint256 => mapping(address => uint256)) private _tokenBalances;
    mapping(uint256 => mapping(address => DelegatedExecutorApproval)) private _delegatedExecutorApprovals;
    /// @dev Per-agent (dexContractAddress => (dexFunctionSelector => allowed))
    mapping(uint256 => mapping(address => mapping(bytes4 => bool))) private _allowedDexCalls;
    /// @dev Per-agent token allowlist for both input and output sides
    mapping(uint256 => mapping(address => bool)) private _allowedTradeTokens;

    uint256 private _reentrancyState = 1;

    event AgentCreated(uint256 indexed agentId, address indexed owner, bytes metadata, uint256 timestamp);
    event MetadataUpdated(uint256 indexed agentId, bytes metadata);
    event DelegatedExecutionUpdated(uint256 indexed agentId, bool enabled);
    event AgentPaused(uint256 indexed agentId, bool paused);

    event NativeDeposited(uint256 indexed agentId, address indexed from, uint256 amount, uint256 newBalance);
    event NativeWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount, uint256 newBalance);
    event TokenDeposited(uint256 indexed agentId, address indexed token, address indexed from, uint256 amount, uint256 newBalance);
    event TokenWithdrawn(uint256 indexed agentId, address indexed token, address indexed to, uint256 amount, uint256 newBalance);

    event AllowedDexCallSet(uint256 indexed agentId, address indexed dexContractAddress, bytes4 indexed dexFunctionSelector, bool allowed);
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
    event TokenSpotTradeExecuted(
        uint256 indexed agentId,
        address indexed delegatedExecutor,
        address indexed dexContractAddress,
        bytes4  dexFunctionSelector,
        address inputTokenAddress,
        address outputTokenAddress,
        uint256 maxInputAmount,
        uint256 inputAmountSpent,
        uint256 minOutputAmount,
        uint256 outputAmountReceived,
        uint256 tradeNotionalValueWei,
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
    error DexCallNotAllowed(uint256 agentId, address dexContractAddress, bytes4 dexFunctionSelector);
    error TradeTokenNotAllowed(uint256 agentId, address tokenAddress);
    error InsufficientNativeBalance(uint256 agentId, uint256 requested, uint256 available);
    error InsufficientTokenBalance(uint256 agentId, address token, uint256 requested, uint256 available);
    error TradeNotionalLimitExceeded(uint256 agentId, address executor, uint256 attempted, uint256 limit);
    error DailyTradeNotionalLimitExceeded(uint256 agentId, address executor, uint256 attemptedTotal, uint256 dailyLimit);
    error InvalidTokenPair(address tokenIn, address tokenOut);
    error SlippageExceeded(uint256 minAmountOut, uint256 actualAmountOut);
    error ExternalCallFailed(bytes reason);
    error NativeAccountingInvariant();
    error ERC20QueryFailed(address token);
    error ERC20OperationFailed(address token);
    error Reentrancy();
    error ExecutionPlanExpired(uint256 executionDeadline, uint256 nowTs);

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
            delegatedExecutionEnabled: false,
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

    /// @notice Allowlist or remove a (dexContractAddress, dexFunctionSelector) pair for an agent.
    function setAllowedDexCall(
        uint256 agentId,
        address dexContractAddress,
        bytes4 dexFunctionSelector,
        bool allowed
    ) external {
        _requireOwner(agentId);
        if (dexContractAddress == address(0)) revert ZeroAddress();
        _allowedDexCalls[agentId][dexContractAddress][dexFunctionSelector] = allowed;
        emit AllowedDexCallSet(agentId, dexContractAddress, dexFunctionSelector, allowed);
    }

    function isDexCallAllowed(
        uint256 agentId,
        address dexContractAddress,
        bytes4 dexFunctionSelector
    ) external view returns (bool) {
        return _allowedDexCalls[agentId][dexContractAddress][dexFunctionSelector];
    }

    /// @notice Allowlist or remove a trade token (both input and output sides).
    function setAllowedTradeToken(uint256 agentId, address tokenAddress, bool allowed) external {
        _requireOwner(agentId);
        if (tokenAddress == address(0)) revert ZeroAddress();
        _allowedTradeTokens[agentId][tokenAddress] = allowed;
        emit AllowedTradeTokenSet(agentId, tokenAddress, allowed);
    }

    function isTradeTokenAllowed(uint256 agentId, address tokenAddress) external view returns (bool) {
        return _allowedTradeTokens[agentId][tokenAddress];
    }

    /// @notice Configure delegated execution permissions for one executor on one agent.
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
            agentId,
            executor,
            canTick,
            canTrade,
            maxTradeNotionalValueWei,
            dailyTradeNotionalLimitWei
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

    /// @notice Execution anchor for one analysis tick.
    function executeTick(uint256 agentId) external {
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);
        _requireTickPermission(agentId, a, msg.sender);
        emit TickExecuted(agentId, msg.sender, block.timestamp);
    }

    /// @notice Execute a spot ERC-20 swap using the agent's token balances.
    /// @param agentId         Agent vault to trade from.
    /// @param dexContractAddress  Address of the DEX router.
    /// @param dexFunctionSelector The 4-byte selector; must match dexCallData[0:4] and be in the allowlist.
    /// @param inputTokenAddress   Token the agent is selling.
    /// @param outputTokenAddress  Token the agent is buying.
    /// @param maxInputAmount      Maximum input tokens to spend (vault must hold this balance).
    /// @param minOutputAmount     Minimum output tokens required (slippage guard).
    /// @param tradeNotionalValueWei Risk-limit value; trusted from executor, not oracle-verified.
    /// @param executionDeadline   Unix timestamp after which the call reverts.
    /// @param dexCallData         Calldata forwarded to the DEX (first 4 bytes must match dexFunctionSelector).
    function executeTokenTrade(
        uint256 agentId,
        address dexContractAddress,
        bytes4  dexFunctionSelector,
        address inputTokenAddress,
        address outputTokenAddress,
        uint256 maxInputAmount,
        uint256 minOutputAmount,
        uint256 tradeNotionalValueWei,
        uint256 executionDeadline,
        bytes calldata dexCallData
    ) external nonReentrant returns (uint256 inputAmountSpent, uint256 outputAmountReceived) {
        // 1. Agent must exist and not be paused.
        AgentState storage a = _requireAgent(agentId);
        if (a.paused) revert AgentIsPaused(agentId);

        // 2. Deadline check.
        if (block.timestamp > executionDeadline) revert ExecutionPlanExpired(executionDeadline, block.timestamp);

        // 3. Address / pair sanity.
        if (dexContractAddress == address(0) || inputTokenAddress == address(0) || outputTokenAddress == address(0)) revert ZeroAddress();
        if (inputTokenAddress == outputTokenAddress) revert InvalidTokenPair(inputTokenAddress, outputTokenAddress);

        // 4. Amount sanity.
        if (maxInputAmount == 0) revert ZeroAmount();
        if (tradeNotionalValueWei == 0) revert ZeroAmount();

        // 5. Calldata prefix check (prevents calldata-prefix forgery).
        if (dexCallData.length < 4 || bytes4(dexCallData[0:4]) != dexFunctionSelector) {
            revert DexCallNotAllowed(agentId, dexContractAddress, dexFunctionSelector);
        }

        // 6. DEX call allowlist.
        if (!_allowedDexCalls[agentId][dexContractAddress][dexFunctionSelector]) {
            revert DexCallNotAllowed(agentId, dexContractAddress, dexFunctionSelector);
        }

        // 7. Trade token allowlist.
        if (!_allowedTradeTokens[agentId][inputTokenAddress]) revert TradeTokenNotAllowed(agentId, inputTokenAddress);
        if (!_allowedTradeTokens[agentId][outputTokenAddress]) revert TradeTokenNotAllowed(agentId, outputTokenAddress);

        // 8. Sufficient vault balance.
        uint256 vaultInput = _tokenBalances[agentId][inputTokenAddress];
        if (vaultInput < maxInputAmount) revert InsufficientTokenBalance(agentId, inputTokenAddress, maxInputAmount, vaultInput);

        // 9. Delegated execution checks (owner can always trade; non-owner needs delegation).
        if (msg.sender != a.owner) {
            if (!a.delegatedExecutionEnabled) revert DelegatedExecutionDisabled(agentId);
            _consumeTradeNotionalAllowance(agentId, a, msg.sender, tradeNotionalValueWei);
        }

        uint256 tokenInBefore = _erc20Balance(inputTokenAddress, address(this));
        uint256 tokenOutBefore = _erc20Balance(outputTokenAddress, address(this));

        _tokenBalances[agentId][inputTokenAddress] = vaultInput - maxInputAmount;

        _safeApprove(inputTokenAddress, dexContractAddress, 0);
        _safeApprove(inputTokenAddress, dexContractAddress, maxInputAmount);

        (bool ok, bytes memory returnData) = dexContractAddress.call(dexCallData);
        _safeApprove(inputTokenAddress, dexContractAddress, 0);

        if (!ok) revert ExternalCallFailed(returnData);

        uint256 tokenInAfter = _erc20Balance(inputTokenAddress, address(this));
        uint256 tokenOutAfter = _erc20Balance(outputTokenAddress, address(this));

        if (tokenInAfter > tokenInBefore) {
            uint256 refundedIn = tokenInAfter - tokenInBefore;
            _tokenBalances[agentId][inputTokenAddress] += refundedIn;
            inputAmountSpent = maxInputAmount > refundedIn ? maxInputAmount - refundedIn : 0;
        } else {
            inputAmountSpent = tokenInBefore - tokenInAfter;
            if (inputAmountSpent > maxInputAmount) revert NativeAccountingInvariant();
        }

        outputAmountReceived = tokenOutAfter > tokenOutBefore ? tokenOutAfter - tokenOutBefore : 0;
        if (outputAmountReceived < minOutputAmount) revert SlippageExceeded(minOutputAmount, outputAmountReceived);

        _tokenBalances[agentId][outputTokenAddress] += outputAmountReceived;

        emit TokenSpotTradeExecuted(
            agentId,
            msg.sender,
            dexContractAddress,
            dexFunctionSelector,
            inputTokenAddress,
            outputTokenAddress,
            maxInputAmount,
            inputAmountSpent,
            minOutputAmount,
            outputAmountReceived,
            tradeNotionalValueWei,
            executionDeadline
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
