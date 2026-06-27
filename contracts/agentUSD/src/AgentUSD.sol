// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title AgentUSD — controlled-supply stablecoin for automated payment testing
/// @notice Supply is fully controlled by owner. Used only on testnets.
contract AgentUSD is ERC20, Ownable {
    uint8 private constant _DECIMALS = 6; // matches USDC/USDT

    constructor(address initialOwner) ERC20("AgentUSD", "aUSD") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }

    /// @notice Mint tokens to any address. Owner only.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Burn tokens from caller's balance.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
