// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice TEST ONLY. Freely mintable ERC20 standing in for the real lent
 * asset (a testnet token or provided aUSDC, wired at deployment later) and
 * for the collateral asset, both are the same MockERC20 in tests, matching
 * LendingPool's documented same-asset simplification.
 *
 * NEVER deploy this to any network where it could be mistaken for a real
 * asset, `mint` is unrestricted by design, purely for test setup.
 */
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice TEST ONLY. Unrestricted mint for test setup.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
