// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";
import {ScriptBase} from "./ScriptBase.sol";
import {Agent} from "../src/Agent.sol";

contract DeployAgent is ScriptBase {
    function run() external returns (address deployed) {
        _startBroadcast();

        Agent agent = new Agent();
        vm.stopBroadcast();

        deployed = address(agent);
        console.log("Agent deployed at:", deployed);

        // Write address to .env.contracts for frontend consumption
        string memory envLine = string.concat("VITE_AGENT_CONTRACT_ADDRESS=", vm.toString(deployed));
        console.log(envLine);
    }
}
