// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Agent} from "../src/Agent.sol";

contract AgentEntryPointTest is Test {
    Agent internal agent;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() external {
        agent = new Agent();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 50 ether);
    }

    function _createAliceAgent(bytes memory metadata) internal returns (uint256 agentId) {
        vm.prank(alice);
        agentId = agent.createAgent(metadata);
    }

    function test_createAgent_assignsSequentialIds() external {
        uint256 a1 = _createAliceAgent(bytes("alice-1"));
        uint256 a2 = _createAliceAgent(bytes("alice-2"));

        vm.prank(bob);
        uint256 b1 = agent.createAgent(bytes("bob-1"));

        assertEq(a1, 1);
        assertEq(a2, 2);
        assertEq(b1, 3);

        uint256[] memory ids = agent.ownerAgentIds(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], a1);
        assertEq(ids[1], a2);
    }

    function test_nativeDepositAndWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("vault"));

        vm.prank(alice);
        agent.depositNative{value: 4 ether}(agentId);

        (, , uint256 nativeBalance, bool exists, bool delegatedExecutionEnabled, bool paused) = agent.getAgent(agentId);
        assertTrue(exists);
        assertFalse(delegatedExecutionEnabled);
        assertFalse(paused);
        assertEq(nativeBalance, 4 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        agent.withdrawNative(agentId, 1.5 ether, payable(alice));

        assertEq(alice.balance, before + 1.5 ether);
        (, , nativeBalance, , , ) = agent.getAgent(agentId);
        assertEq(nativeBalance, 2.5 ether);
    }

    function test_onlyOwnerCanWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("vault"));
        vm.prank(alice);
        agent.depositNative{value: 1 ether}(agentId);

        vm.expectRevert(abi.encodeWithSelector(Agent.NotAgentOwner.selector, agentId, bob));
        vm.prank(bob);
        agent.withdrawNative(agentId, 0.2 ether, payable(bob));
    }

    function test_setDelegatedExecutionEnabled() external {
        uint256 agentId = _createAliceAgent(bytes("delegated-exec"));

        vm.prank(alice);
        agent.setDelegatedExecutionEnabled(agentId, true);

        (, , , , bool delegatedExecutionEnabled, ) = agent.getAgent(agentId);
        assertTrue(delegatedExecutionEnabled);

        vm.prank(alice);
        agent.setDelegatedExecutionEnabled(agentId, false);

        (, , , , delegatedExecutionEnabled, ) = agent.getAgent(agentId);
        assertFalse(delegatedExecutionEnabled);
    }
}
