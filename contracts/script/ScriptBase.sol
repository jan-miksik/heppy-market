// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

abstract contract ScriptBase is Script {
    /// @dev Resolves the broadcaster: private key > DEPLOYER env var > default sender.
    ///      Returns the deployer address and starts broadcast.
    function _startBroadcast() internal returns (address deployer) {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerPrivateKey != 0) {
            deployer = vm.addr(deployerPrivateKey);
            vm.startBroadcast(deployerPrivateKey);
        } else {
            deployer = vm.envOr("DEPLOYER", address(0));
            if (deployer != address(0)) {
                vm.startBroadcast(deployer);
            } else {
                vm.startBroadcast();
            }
        }
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
    }
}
