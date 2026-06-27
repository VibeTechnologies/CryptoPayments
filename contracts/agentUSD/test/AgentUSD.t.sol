// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {AgentUSD} from "../src/AgentUSD.sol";

contract AgentUSDTest is Test {
    AgentUSD public token;
    address owner = address(this);
    address testWallet = address(0xBEEF);

    function setUp() public {
        token = new AgentUSD(owner);
    }

    function test_name() public view {
        assertEq(token.name(), "AgentUSD");
        assertEq(token.symbol(), "aUSD");
        assertEq(token.decimals(), 6);
    }

    function test_mint() public {
        token.mint(testWallet, 100 * 10**6); // 100 aUSD
        assertEq(token.balanceOf(testWallet), 100 * 10**6);
    }

    function test_mint_onlyOwner() public {
        vm.prank(testWallet);
        vm.expectRevert();
        token.mint(testWallet, 100 * 10**6);
    }

    function test_burn() public {
        token.mint(testWallet, 100 * 10**6);
        vm.prank(testWallet);
        token.burn(50 * 10**6);
        assertEq(token.balanceOf(testWallet), 50 * 10**6);
    }

    function test_transfer() public {
        token.mint(owner, 100 * 10**6);
        token.transfer(testWallet, 25 * 10**6);
        assertEq(token.balanceOf(testWallet), 25 * 10**6);
    }
}
