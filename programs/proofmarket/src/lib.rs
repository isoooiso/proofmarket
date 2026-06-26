use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("9ZQJXjeop6xGjFAEvVTgHvWiBnbkVB9AMxo4D8aihxZs");

// --------------------------------------------------------------------------- TxLINE types
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

pub const TXLINE_PROGRAM_ID: Pubkey =
    pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

// --------------------------------------------------------------------------- accounts
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub fixture_id: i64,
    pub period: i32,
    pub stat_a_key: u32,
    pub stat_b_key: Option<u32>,
    pub op: Option<BinaryExpression>,
    pub yes_threshold: i32,
    pub usdc_mint: Pubkey,
    pub pool_yes: u64,
    pub pool_no: u64,
    pub winning_side: u8,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

// --------------------------------------------------------------------------- program
#[program]
pub mod proofmarket {
    use super::*;

    pub fn create_market(
        ctx: Context<CreateMarket>,
        fixture_id: i64,
        period: i32,
        stat_a_key: u32,
        stat_b_key: Option<u32>,
        op: Option<BinaryExpression>,
        yes_threshold: i32,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.fixture_id = fixture_id;
        market.period = period;
        market.stat_a_key = stat_a_key;
        market.stat_b_key = stat_b_key;
        market.op = op;
        market.yes_threshold = yes_threshold;
        market.usdc_mint = ctx.accounts.usdc_mint.key();
        market.pool_yes = 0;
        market.pool_no = 0;
        market.winning_side = 0;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, side: u8, amount: u64) -> Result<()> {
        require!(ctx.accounts.market.winning_side == 0, PmError::MarketClosed);
        require!(side == 1 || side == 2, PmError::BadSide);
        require!(amount > 0, PmError::BadSide);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let position = &mut ctx.accounts.position;
        if position.market == Pubkey::default() {
            position.market = ctx.accounts.market.key();
            position.user = ctx.accounts.user.key();
            position.side = side;
            position.claimed = false;
            position.bump = ctx.bumps.position;
        } else {
            require!(position.side == side, PmError::BadSide);
        }
        position.amount = position
            .amount
            .checked_add(amount)
            .ok_or(PmError::BadSide)?;

        let market = &mut ctx.accounts.market;
        if side == 1 {
            market.pool_yes = market
                .pool_yes
                .checked_add(amount)
                .ok_or(PmError::BadSide)?;
        } else {
            market.pool_no = market
                .pool_no
                .checked_add(amount)
                .ok_or(PmError::BadSide)?;
        }

        Ok(())
    }

    pub fn settle_market(
        ctx: Context<SettleMarket>,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        predicate: TraderPredicate,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
        claimed_outcome: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.winning_side == 0, PmError::MarketClosed);
        require!(
            claimed_outcome == 1 || claimed_outcome == 2,
            PmError::BadSide
        );
        require!(
            ctx.accounts.txline_program.key() == TXLINE_PROGRAM_ID,
            PmError::WrongReturnProgram
        );

        require!(
            fixture_summary.fixture_id == market.fixture_id,
            PmError::FixtureMismatch
        );
        require!(
            stat_a.stat_to_prove.key == market.stat_a_key,
            PmError::StatMismatch
        );
        require!(
            stat_a.stat_to_prove.period == market.period,
            PmError::StatMismatch
        );
        require!(op == market.op, PmError::StatMismatch);
        match (&stat_b, &market.stat_b_key) {
            (Some(b), Some(k)) => require!(b.stat_to_prove.key == *k, PmError::StatMismatch),
            (None, None) => {}
            _ => return err!(PmError::StatMismatch),
        }

        if claimed_outcome == 1 {
            require!(
                predicate.threshold == market.yes_threshold
                    && predicate.comparison == Comparison::GreaterThan,
                PmError::PredicateMismatch
            );
        } else {
            require!(
                predicate.threshold == market.yes_threshold + 1
                    && predicate.comparison == Comparison::LessThan,
                PmError::PredicateMismatch
            );
        }

        let mut data = VALIDATE_STAT_DISCRIMINATOR.to_vec();
        ts.serialize(&mut data)?;
        fixture_summary.serialize(&mut data)?;
        fixture_proof.serialize(&mut data)?;
        main_tree_proof.serialize(&mut data)?;
        predicate.serialize(&mut data)?;
        stat_a.serialize(&mut data)?;
        stat_b.serialize(&mut data)?;
        op.serialize(&mut data)?;

        let ix = Instruction {
            program_id: TXLINE_PROGRAM_ID,
            accounts: vec![AccountMeta::new_readonly(
                ctx.accounts.daily_scores_merkle_roots.key(),
                false,
            )],
            data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts
                    .daily_scores_merkle_roots
                    .to_account_info(),
                ctx.accounts.txline_program.to_account_info(),
            ],
        )?;

        let (ret_prog, ret) = get_return_data().ok_or(error!(PmError::NoReturnData))?;
        require!(ret_prog == TXLINE_PROGRAM_ID, PmError::WrongReturnProgram);
        require!(ret == vec![1u8], PmError::PredicateNotTrue);

        market.winning_side = claimed_outcome;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.winning_side != 0, PmError::MarketNotResolved);
        require!(
            ctx.accounts.position.side == market.winning_side,
            PmError::BadSide
        );
        require!(!ctx.accounts.position.claimed, PmError::AlreadyClaimed);

        let total = market
            .pool_yes
            .checked_add(market.pool_no)
            .ok_or(PmError::NothingToClaim)?;
        let win_pool = if market.winning_side == 1 {
            market.pool_yes
        } else {
            market.pool_no
        };
        require!(win_pool > 0, PmError::NothingToClaim);

        let payout = (ctx.accounts.position.amount as u128)
            .checked_mul(total as u128)
            .ok_or(PmError::NothingToClaim)?
            .checked_div(win_pool as u128)
            .ok_or(PmError::NothingToClaim)? as u64;

        let authority_key = market.authority;
        let fixture_id = market.fixture_id;
        let yes_threshold = market.yes_threshold;
        let bump = market.bump;
        let seeds = &[
            b"market",
            authority_key.as_ref(),
            &fixture_id.to_le_bytes(),
            &yes_threshold.to_le_bytes(),
            &[bump],
        ];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;

        ctx.accounts.position.claimed = true;
        Ok(())
    }
}

// --------------------------------------------------------------------------- account contexts
#[derive(Accounts)]
#[instruction(
    fixture_id: i64,
    period: i32,
    stat_a_key: u32,
    stat_b_key: Option<u32>,
    op: Option<BinaryExpression>,
    yes_threshold: i32,
)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [
            b"market",
            authority.key().as_ref(),
            &fixture_id.to_le_bytes(),
            &yes_threshold.to_le_bytes(),
        ],
        bump,
    )]
    pub market: Account<'info, Market>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [
            b"market",
            market.authority.as_ref(),
            &market.fixture_id.to_le_bytes(),
            &market.yes_threshold.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == market.usdc_mint @ PmError::BadSide,
        constraint = user_usdc.owner == user.key() @ PmError::BadSide,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(
        mut,
        seeds = [
            b"market",
            market.authority.as_ref(),
            &market.fixture_id.to_le_bytes(),
            &market.yes_threshold.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// CHECK: TxLINE daily_scores_roots PDA — validated by CPI
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,

    /// CHECK: TxLINE program
    #[account(address = TXLINE_PROGRAM_ID)]
    pub txline_program: UncheckedAccount<'info>,

    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [
            b"market",
            market.authority.as_ref(),
            &market.fixture_id.to_le_bytes(),
            &market.yes_threshold.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = market,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == market.usdc_mint @ PmError::BadSide,
        constraint = user_usdc.owner == user.key() @ PmError::BadSide,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// --------------------------------------------------------------------------- errors
#[error_code]
pub enum PmError {
    #[msg("Market is closed for deposits")]
    MarketClosed,
    #[msg("Market is not resolved yet")]
    MarketNotResolved,
    #[msg("Invalid side or amount")]
    BadSide,
    #[msg("Fixture ID does not match market")]
    FixtureMismatch,
    #[msg("Stat configuration does not match market")]
    StatMismatch,
    #[msg("Predicate does not match claimed outcome")]
    PredicateMismatch,
    #[msg("validate_stat returned no return data")]
    NoReturnData,
    #[msg("Return data program id is not TxLINE")]
    WrongReturnProgram,
    #[msg("validate_stat predicate was not true")]
    PredicateNotTrue,
    #[msg("Position already claimed")]
    AlreadyClaimed,
    #[msg("Nothing to claim")]
    NothingToClaim,
}
