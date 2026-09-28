//! # Juno CurveMath — Stylus program
//!
//! Prices every buy and sell on every Juno curve. Solidity `JunoCurve`
//! contracts call it like any contract; it is written in Rust and compiled to
//! WASM, because the inverse search (how many tokens does this much ETH buy?)
//! runs ~90 iterations of 512-bit maths per trade — cheap in WASM, expensive
//! in the EVM.
//!
//! Stateless and pure. The maths lives in `math.rs` and matches
//! `contracts/src/CurveMathRef.sol` exactly.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

pub mod math;

use alloc::vec::Vec;
use alloy_sol_types::sol;
use stylus_sdk::{alloy_primitives::U256, prelude::*};

sol! {
    error BadPreset();
    error BadCap();
    error Exceeds();
}

#[derive(SolidityError)]
pub enum CurveMathError {
    BadPreset(BadPreset),
    BadCap(BadCap),
    Exceeds(Exceeds),
}

impl From<math::MathError> for CurveMathError {
    fn from(e: math::MathError) -> Self {
        match e {
            math::MathError::BadPreset => CurveMathError::BadPreset(BadPreset {}),
            math::MathError::BadCap => CurveMathError::BadCap(BadCap {}),
            math::MathError::Exceeds => CurveMathError::Exceeds(Exceeds {}),
        }
    }
}

#[storage]
#[entrypoint]
pub struct CurveMath {}

#[public]
impl CurveMath {
    pub fn boundaries(&self, preset: u8, p0: U256, cap_fp: U256, supply: U256) -> Result<(Vec<U256>, Vec<U256>), CurveMathError> {
        Ok(math::boundaries(preset, p0, cap_fp, supply)?)
    }

    pub fn price_at(&self, preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256) -> Result<U256, CurveMathError> {
        Ok(math::price_at(preset, p0, cap_fp, supply, sold)?)
    }

    pub fn cost_to_buy(&self, preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256, amount: U256) -> Result<U256, CurveMathError> {
        Ok(math::cost_to_buy(preset, p0, cap_fp, supply, sold, amount)?)
    }

    pub fn proceeds_to_sell(&self, preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256, amount: U256) -> Result<U256, CurveMathError> {
        Ok(math::proceeds_to_sell(preset, p0, cap_fp, supply, sold, amount)?)
    }

    pub fn amount_for_cost(&self, preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256, cost: U256) -> Result<U256, CurveMathError> {
        Ok(math::amount_for_cost(preset, p0, cap_fp, supply, sold, cost)?)
    }

    pub fn fee_bps(&self, start_bps: U256, end_bps: U256, decay_seconds: U256, elapsed: U256) -> U256 {
        math::fee_bps(start_bps, end_bps, decay_seconds, elapsed)
    }
}
