// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Agent, IERC20Like} from "../src/Agent.sol";

contract MockERC20 is IERC20Like {
    string public name;
    string public symbol;
    uint8 public immutable decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 bal = balanceOf[msg.sender];
        require(bal >= amount, "insufficient");
        balanceOf[msg.sender] = bal - amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "insufficient");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract MockTokenRouter {
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

contract AgentExecutionTest is Test {
    Agent internal vault;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockTokenRouter internal tokenRouter;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal executor = makeAddr("executor");

    bytes4 internal swapSelector = MockTokenRouter.swapExactIn.selector;

    function setUp() external {
        vault = new Agent();
        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped ETH", "WETH");
        tokenRouter = new MockTokenRouter();

        vm.deal(alice, 100 ether);
        vm.deal(bob, 50 ether);

        usdc.mint(alice, 1_000_000e18);
        weth.mint(alice, 1_000_000e18);
    }

    function _createAliceAgent(bytes memory metadata) internal returns (uint256 agentId) {
        vm.prank(alice);
        agentId = vault.createAgent(metadata);
    }

    /// @dev Full spot-trade setup: deposit tokens, enable delegated execution,
    ///      allowlist dex call + tokens, set executor approval with notional limits.
    function _setupSpotTrade(
        uint256 agentId,
        uint256 depositAmount,
        uint128 maxTradeNotional,
        uint128 dailyNotional
    ) internal {
        vm.startPrank(alice);
        usdc.approve(address(vault), depositAmount);
        vault.depositToken(agentId, address(usdc), depositAmount);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setAllowedDexCall(agentId, address(tokenRouter), swapSelector, true);
        vault.setAllowedTradeToken(agentId, address(usdc), true);
        vault.setAllowedTradeToken(agentId, address(weth), true);
        vault.setDelegatedExecutorApproval(agentId, executor, false, true, maxTradeNotional, dailyNotional);
        vm.stopPrank();
    }

    function _buildSwapCalldata(uint256 amountIn, uint256 amountOut) internal view returns (bytes memory) {
        return abi.encodeCall(MockTokenRouter.swapExactIn, (address(usdc), address(weth), amountIn, amountOut));
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 60;
    }

    // ── Existing tests updated for renamed API ─────────────────────────────

    function test_createMultipleAgentsPerUser() external {
        uint256 a1 = _createAliceAgent(bytes("alice-1"));
        uint256 a2 = _createAliceAgent(bytes("alice-2"));

        vm.prank(bob);
        uint256 b1 = vault.createAgent(bytes("bob-1"));

        uint256[] memory aliceAgents = vault.ownerAgentIds(alice);
        uint256[] memory bobAgents = vault.ownerAgentIds(bob);

        assertEq(aliceAgents.length, 2);
        assertEq(aliceAgents[0], a1);
        assertEq(aliceAgents[1], a2);
        assertEq(bobAgents.length, 1);
        assertEq(bobAgents[0], b1);
    }

    function test_nativeDepositAndWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("native"));

        vm.prank(alice);
        vault.depositNative{value: 5 ether}(agentId);

        (, , uint256 nativeBalance, bool exists, , ) = vault.getAgent(agentId);
        assertTrue(exists);
        assertEq(nativeBalance, 5 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdrawNative(agentId, 2 ether, payable(alice));
        assertEq(alice.balance, before + 2 ether);

        (, , nativeBalance, , , ) = vault.getAgent(agentId);
        assertEq(nativeBalance, 3 ether);
    }

    function test_tokenDepositAndWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("token"));

        vm.startPrank(alice);
        usdc.approve(address(vault), 400e18);
        vault.depositToken(agentId, address(usdc), 400e18);
        vm.stopPrank();

        assertEq(vault.tokenBalance(agentId, address(usdc)), 400e18);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdrawToken(agentId, address(usdc), 150e18, alice);

        assertEq(vault.tokenBalance(agentId, address(usdc)), 250e18);
        assertEq(usdc.balanceOf(alice), before + 150e18);
    }

    function test_executorCanExecuteTickWhenApproved() external {
        uint256 agentId = _createAliceAgent(bytes("tick"));

        vm.startPrank(alice);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setDelegatedExecutorApproval(agentId, executor, true, false, 0, 0);
        vm.stopPrank();

        vm.prank(executor);
        vault.executeTick(agentId);
    }

    function test_nonOwnerCannotWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("owner-only"));
        vm.prank(alice);
        vault.depositNative{value: 1 ether}(agentId);

        vm.expectRevert(abi.encodeWithSelector(Agent.NotAgentOwner.selector, agentId, bob));
        vm.prank(bob);
        vault.withdrawNative(agentId, 1 ether, payable(bob));
    }

    function test_executeTokenTrade_updatesAgentBalances() external {
        uint256 agentId = _createAliceAgent(bytes("token-trade"));
        _setupSpotTrade(agentId, 300e18, 0, 0);

        bytes memory callData = _buildSwapCalldata(120e18, 105e18);
        vm.prank(executor);
        (uint256 amountInSpent, uint256 amountOutReceived) = vault.executeTokenTrade(
            agentId,
            address(tokenRouter),
            swapSelector,
            address(usdc),
            address(weth),
            120e18,
            100e18,
            120e18,
            _deadline(),
            callData
        );

        assertEq(amountInSpent, 120e18);
        assertEq(amountOutReceived, 105e18);
        assertEq(vault.tokenBalance(agentId, address(usdc)), 180e18);
        assertEq(vault.tokenBalance(agentId, address(weth)), 105e18);
    }

    // ── New tests (Part 1.9) ──────────────────────────────────────────────

    function test_executeTokenTrade_consumesPerTradeNotionalLimit() external {
        uint256 agentId = _createAliceAgent(bytes("notional-per-trade"));
        // maxTradeNotional = 100e18; attempt 120e18 → revert
        _setupSpotTrade(agentId, 300e18, uint128(100e18), 0);

        bytes memory callData = _buildSwapCalldata(120e18, 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(Agent.TradeNotionalLimitExceeded.selector, agentId, executor, 120e18, 100e18)
        );
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 120e18, 0, 120e18, _deadline(), callData);
    }

    function test_executeTokenTrade_consumesDailyNotionalLimit() external {
        uint256 agentId = _createAliceAgent(bytes("notional-daily"));
        // dailyLimit = 150e18; first trade 100e18 ok; second pushes total to 200e18 → revert
        _setupSpotTrade(agentId, 300e18, 0, uint128(150e18));

        bytes memory callData1 = _buildSwapCalldata(100e18, 90e18);
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData1);

        bytes memory callData2 = _buildSwapCalldata(100e18, 90e18);
        vm.expectRevert(
            abi.encodeWithSelector(Agent.DailyTradeNotionalLimitExceeded.selector, agentId, executor, 200e18, 150e18)
        );
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData2);
    }

    function test_executeTokenTrade_dailyNotionalRollover() external {
        uint256 agentId = _createAliceAgent(bytes("daily-rollover"));
        _setupSpotTrade(agentId, 300e18, 0, uint128(150e18));

        uint256 ts = block.timestamp;
        bytes memory callData = _buildSwapCalldata(100e18, 90e18);
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, ts + 60, callData);

        // Warp forward 1 day — counter resets, second trade should succeed
        vm.warp(ts + 1 days);

        bytes memory callData2 = _buildSwapCalldata(100e18, 90e18);
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, ts + 1 days + 60, callData2);
    }

    function test_executeTokenTrade_rejectsUnknownDexFunctionSelector() external {
        uint256 agentId = _createAliceAgent(bytes("bad-selector"));
        _setupSpotTrade(agentId, 300e18, 0, 0);

        bytes4 badSelector = bytes4(keccak256("unknownFunc(address,uint256)"));
        bytes memory callData = abi.encodeWithSelector(badSelector, address(usdc), 100e18);

        vm.expectRevert(
            abi.encodeWithSelector(Agent.DexCallNotAllowed.selector, agentId, address(tokenRouter), badSelector)
        );
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), badSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData);
    }

    function test_executeTokenTrade_rejectsCalldataPrefixMismatch() external {
        uint256 agentId = _createAliceAgent(bytes("prefix-mismatch"));
        _setupSpotTrade(agentId, 300e18, 0, 0);

        // calldata has real swapSelector prefix; argument claims a different selector
        bytes memory callData = _buildSwapCalldata(100e18, 90e18);
        bytes4 wrongSelector = bytes4(keccak256("differentFunc()"));

        // Allowlist wrongSelector too so only the prefix check fires
        vm.prank(alice);
        vault.setAllowedDexCall(agentId, address(tokenRouter), wrongSelector, true);

        vm.expectRevert(
            abi.encodeWithSelector(Agent.DexCallNotAllowed.selector, agentId, address(tokenRouter), wrongSelector)
        );
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), wrongSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData);
    }

    function test_executeTokenTrade_rejectsDisallowedInputToken() external {
        uint256 agentId = _createAliceAgent(bytes("bad-input-token"));

        vm.startPrank(alice);
        usdc.approve(address(vault), 200e18);
        vault.depositToken(agentId, address(usdc), 200e18);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setAllowedDexCall(agentId, address(tokenRouter), swapSelector, true);
        // usdc NOT allowlisted as trade token
        vault.setAllowedTradeToken(agentId, address(weth), true);
        vault.setDelegatedExecutorApproval(agentId, executor, false, true, 0, 0);
        vm.stopPrank();

        bytes memory callData = _buildSwapCalldata(100e18, 90e18);
        vm.expectRevert(
            abi.encodeWithSelector(Agent.TradeTokenNotAllowed.selector, agentId, address(usdc))
        );
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData);
    }

    function test_executeTokenTrade_rejectsDisallowedOutputToken() external {
        uint256 agentId = _createAliceAgent(bytes("bad-output-token"));

        vm.startPrank(alice);
        usdc.approve(address(vault), 200e18);
        vault.depositToken(agentId, address(usdc), 200e18);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setAllowedDexCall(agentId, address(tokenRouter), swapSelector, true);
        vault.setAllowedTradeToken(agentId, address(usdc), true);
        // weth NOT allowlisted as trade token
        vault.setDelegatedExecutorApproval(agentId, executor, false, true, 0, 0);
        vm.stopPrank();

        bytes memory callData = _buildSwapCalldata(100e18, 90e18);
        vm.expectRevert(
            abi.encodeWithSelector(Agent.TradeTokenNotAllowed.selector, agentId, address(weth))
        );
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData);
    }

    function test_executeTokenTrade_rejectsWhenAgentPaused() external {
        uint256 agentId = _createAliceAgent(bytes("paused-agent"));
        _setupSpotTrade(agentId, 200e18, 0, 0);

        vm.prank(alice);
        vault.setPaused(agentId, true);

        bytes memory callData = _buildSwapCalldata(100e18, 90e18);
        vm.expectRevert(abi.encodeWithSelector(Agent.AgentIsPaused.selector, agentId));
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData);
    }

    function test_executeTokenTrade_rejectsWhenDelegatedExecutionDisabled() external {
        uint256 agentId = _createAliceAgent(bytes("no-delegation"));

        vm.startPrank(alice);
        usdc.approve(address(vault), 200e18);
        vault.depositToken(agentId, address(usdc), 200e18);
        vault.setAllowedDexCall(agentId, address(tokenRouter), swapSelector, true);
        vault.setAllowedTradeToken(agentId, address(usdc), true);
        vault.setAllowedTradeToken(agentId, address(weth), true);
        vault.setDelegatedExecutorApproval(agentId, executor, false, true, 0, 0);
        // delegatedExecutionEnabled intentionally left false
        vm.stopPrank();

        bytes memory callData = _buildSwapCalldata(100e18, 90e18);
        vm.expectRevert(abi.encodeWithSelector(Agent.DelegatedExecutionDisabled.selector, agentId));
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, _deadline(), callData);
    }

    function test_executeTokenTrade_rejectsExpiredDeadline() external {
        uint256 agentId = _createAliceAgent(bytes("deadline"));
        _setupSpotTrade(agentId, 200e18, 0, 0);

        uint256 deadline = block.timestamp + 60;
        vm.warp(deadline + 1);

        bytes memory callData = _buildSwapCalldata(100e18, 90e18);
        vm.expectRevert(
            abi.encodeWithSelector(Agent.ExecutionPlanExpired.selector, deadline, block.timestamp)
        );
        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 100e18, 0, 100e18, deadline, callData);
    }

    function test_executeTokenTrade_emitsTokenSpotTradeExecuted() external {
        uint256 agentId = _createAliceAgent(bytes("emit-test"));
        _setupSpotTrade(agentId, 300e18, 0, 0);

        uint256 deadline = block.timestamp + 60;
        bytes memory callData = _buildSwapCalldata(120e18, 105e18);

        vm.expectEmit(true, true, true, true);
        emit Agent.TokenSpotTradeExecuted(
            agentId,
            executor,
            address(tokenRouter),
            swapSelector,
            address(usdc),
            address(weth),
            120e18,
            120e18,
            100e18,
            105e18,
            120e18,
            deadline
        );

        vm.prank(executor);
        vault.executeTokenTrade(agentId, address(tokenRouter), swapSelector, address(usdc), address(weth), 120e18, 100e18, 120e18, deadline, callData);
    }

    function test_setAllowedDexCall_ownerOnly() external {
        uint256 agentId = _createAliceAgent(bytes("dex-owner"));
        vm.expectRevert(abi.encodeWithSelector(Agent.NotAgentOwner.selector, agentId, bob));
        vm.prank(bob);
        vault.setAllowedDexCall(agentId, address(tokenRouter), swapSelector, true);
    }

    function test_setAllowedTradeToken_ownerOnly() external {
        uint256 agentId = _createAliceAgent(bytes("token-owner"));
        vm.expectRevert(abi.encodeWithSelector(Agent.NotAgentOwner.selector, agentId, bob));
        vm.prank(bob);
        vault.setAllowedTradeToken(agentId, address(usdc), true);
    }

    function test_setDelegatedExecutorApproval_storesNotionalLimits() external {
        uint256 agentId = _createAliceAgent(bytes("notional-limits"));

        vm.prank(alice);
        vault.setDelegatedExecutorApproval(agentId, executor, true, true, uint128(500e18), uint128(2000e18));

        (
            bool canTick,
            bool canTrade,
            uint128 maxTradeNotionalValueWei,
            uint128 dailyTradeNotionalLimitWei,
            ,
        ) = vault.getDelegatedExecutorApproval(agentId, executor);

        assertTrue(canTick);
        assertTrue(canTrade);
        assertEq(maxTradeNotionalValueWei, 500e18);
        assertEq(dailyTradeNotionalLimitWei, 2000e18);
    }
}
