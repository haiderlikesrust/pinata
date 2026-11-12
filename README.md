# Piñata

Every buy of the coin hits a 3D piñata. Every sell patches it up. When it breaks, the prize pool is paid out to five buyers as Collector Crypt card packs, bought-back supply of the coin, and USDC.

**The prize pool is USDC.** The coin's pump.fun creator fees arrive in $PUMP (or SOL for a plain SOL coin) and are swapped into USDC before each payout. Any USDC sent to the prize wallet counts toward the pool as well. Then a new piñata drops in.

## Run it (demo mode)

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. Demo mode (`MODE=dry`, the default) uses simulated trades and simulated payouts. Nothing touches the chain and no keys are needed.

```bash
npm test
```

Useful while testing the site (demo mode only; the token is `ADMIN_TOKEN`, default `change-me`):

```bash
curl -X POST localhost:8787/admin/sim/break -H "x-admin-token: change-me"
```

```bash
curl -X POST localhost:8787/admin/sim/trade -H "x-admin-token: change-me" -H "content-type: application/json" -d "{\"side\":\"sell\",\"usd\":500}"
```

Add `?quality=low` or `?quality=high` to the site URL to force the graphics tier.

## The rules

All of these are settings in `.env` (see `.env.example`).

| Rule | Default |
|---|---|
| Piñata HP | `MAX_HP_USD`. Change it for the next round with `POST /admin/max-hp {"usd": 5000}` |
| Buy of $X | X damage |
| Sell of $X | heals X × `SELL_HEAL_FACTOR` (0.5) |
| Final hit | must be a buy of `MIN_BUY_USD` ($10) or more |
| Small pot | under `MIN_POT_USD` ($150) the piñata holds at 1 HP until the pot grows. A break out of that state pays the breaker an ordinary share, not the bonus |
| Time decay | after `DECAY_AFTER_HOURS` (6) it loses `DECAY_PCT_PER_HOUR` (10%) of max HP per hour, down to 1 HP |
| Winners | the wallet that lands the final hit, plus the four biggest single buys of the round. One slot per wallet |
| Not eligible | wallets that sold during the round, wallets that no longer hold what they bought, program-owned accounts, the treasury, anything in `BLOCKLIST` |
| Pot | all USDC in the prize wallet after creator fees are claimed and swapped in |
| Pot split | `SPLIT_PACKS` 25 / `SPLIT_BUYBACK` 25 / `SPLIT_USDC` 50. Packs and USDC come straight from the pool; the buyback share is swapped from USDC into the coin |
| Shares | `WEIGHTS` 30,25,20,15,10 (final hit first) |
| Packs | everyone gets the biggest tier of `PACK_TIERS` that fits, leftovers upgrade by rank, then add packs up to `MAX_PACKS_PER_WINNER`. If the budget cannot cover everyone, $25 packs go to the top ranks. Anything unspent is paid as USDC |
| Payout timing | instant. Set `HOLD_WINDOW_MIN` to 10–30 to check holders and pay after a delay instead |

## How it works

- `server/src/engine` — the rules as pure functions (HP, winners, pot split, pack tiers).
- `server/src/game.ts` — turns trades into HP, decides the break, starts payouts and rounds.
- `server/src/payout/runner.ts` — the payout pipeline. Every transaction is saved, signed, **before** it is sent, and every result is saved once it lands. Re-running a round resumes where it stopped and never pays twice. The tests crash it at every step to prove that.
- `server/src/live` — mainnet: the RPC trade ledger (source of truth, woken by the RPC's websocket so hits show within about a second), an optional PumpPortal feed, pump.fun fee claim, Jupiter swaps, transfers, Collector Crypt packs.
- `server/src/leader.ts` — the lock that lets an update start the new server before the old one stops ([docs/DOKPLOY.md](docs/DOKPLOY.md)).
- `web/src/scene` — the 3D scene. `director.ts` owns all motion; trades in, swings and explosions out.

A break is only declared once the breaking trade is finalized on chain. Packs are bought from a throwaway wallet funded with exactly that round's pack budget, so the treasury key never signs a transaction built by a third party's API.

## Going live

**What has and has not been tested.** The rules, payout pipeline, trade parser and the whole site are tested and were run end to end in demo mode. The trade parser was also checked against real mainnet transactions, and Collector Crypt's public machine list was read live. **The fee claim, Jupiter swaps, token transfers and pack purchases have never been run on mainnet**: they are written against the current SDKs and docs and they type-check, but the first real round is their first real test. Treat it that way.

1. **Launch the coin from a fresh wallet** that holds nothing but creator fees. Keep your own allocation somewhere else. If this key leaks, future fees are likely gone for good.
2. Get a paid RPC URL (Helius, Triton, QuickNode) and a Jupiter API key. That is all the trade feed needs: the RPC's own websocket reports each trade as it lands. A PumpPortal key is optional and not recommended to start with.
3. Check the feeds against any existing graduated pump.fun coin. It spends nothing:
   ```bash
   npm run probe -- <mint> 60
   ```
   Compare a few of the printed trades with Solscan. Then check how fast your RPC reports them:
   ```bash
   npm run probe:latency -w server -- <mint> 30
   ```
   It should print trades picked up about a second after their block. If nothing arrives on a busy coin, the RPC plan may not include websocket subscriptions; the site still works, with hits a few seconds late.
4. Fill in `.env`: `MODE=live`, `MINT`, `TOKEN_SYMBOL`, `QUOTE_MINT` (the $PUMP mint, if the coin is quoted in $PUMP), `RPC_URL`, `JUPITER_API_KEY`, `PUMPPORTAL_API_KEY`, a long random `ADMIN_TOKEN`, and the treasury key (`TREASURY_KEYFILE` pointing at a Solana CLI keyfile is safer than pasting `TREASURY_SECRET_KEY`).
5. Keep about 0.2 SOL in the prize wallet for network fees. With fees arriving in $PUMP and the pool in USDC, nothing tops SOL up for you, and payouts stall if it runs out.
6. **First round, small.** Set `MAX_HP_USD` low and `MIN_POT_USD` to about 60 so the first payout is small. Watch:
   ```bash
   curl localhost:8787/admin/status -H "x-admin-token: <token>"
   ```
   A round that needs a hand shows up under `attention` with the step that failed. After fixing the cause:
   ```bash
   curl -X POST localhost:8787/admin/retry/<round> -H "x-admin-token: <token>"
   ```
7. Buy one $25 pack by hand on Collector Crypt first, and confirm with their support that automated buying to a different recipient wallet is fine for your volume.

### Deploying

One Docker image serves the site and runs the bot. [docs/DOKPLOY.md](docs/DOKPLOY.md) sets it up on Dokploy with zero-downtime updates.

## Worth knowing

- **Sniping.** With instant payouts and a 30% share for the final hit, a bot can land the last hit plus several large buys from separate wallets in one bundle and sell a block later. The no-sell and still-holding checks raise the cost but do not stop it. `HOLD_WINDOW_MIN=15` is the real fix if you see it.
- **Pot size.** Creator fees are a small slice of volume, so a $150 pot takes very roughly $15–45k of trading.
- **Fee sharing.** Do not set up pump.fun fee sharing on the coin: the normal claim stops working once a sharing config exists.
- **Buyback routing.** The buyback swaps USDC into the coin through Jupiter. If Jupiter has no route for the coin yet, that share is not spent: it stays in the wallet as USDC and is part of the next round's pool.
- **Pack delivery.** The pack flow follows a client known to work (validate the payment, submit through Collector Crypt, wait for confirmation, open, confirm delivery), with one difference: it asks Collector Crypt to deliver the card straight to the winner (`altPlayerAddress`). If a card is ever delivered to the pack wallet instead, the round is flagged and the card is safe there.
- **Card art and totals.** In live mode the card image, name and insured value come from Collector Crypt. Totals count a pack at the card's insured value and tokens at what the buyback cost.
- **Law.** Paying prizes to buyers can count as a lottery or sweepstakes in some countries. "Pokémon" is a trademark; the site calls the packs Collector Crypt card packs and uses no Pokémon artwork.
