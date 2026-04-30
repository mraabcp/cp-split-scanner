# CP Split Scanner

Daily SEC EDGAR scanner for stock and ETF split announcements.

## How it works

1. GitHub Actions runs `scanner.js` every weekday at 9am ET
2. Scanner searches EDGAR full-text search for 8-K and 497 filings containing split keywords
3. Regex extracts ticker, ratio, ex-date, and split type from filing text
4. Results written to `splits.json` and committed to this repo
5. `split-scanner-display.html` (hosted on artifacts.ceritypartners.com) reads the JSON and renders the table

## Setup

### 1. Make the repo public
GitHub Actions can write to the repo using the built-in `GITHUB_TOKEN` (already configured in the workflow). The display HTML reads `splits.json` from the raw GitHub URL, which requires the repo to be **public**.

If you prefer a private repo, you'll need to add a Personal Access Token (PAT) as a repository secret — ask Claude for help with that step.

### 2. Trigger the first scan manually
Go to: **Actions → SEC Split Scanner → Run workflow**

This runs the scanner immediately rather than waiting for the 9am schedule.

### 3. Upload the display page
Upload `split-scanner-display.html` to `artifacts.ceritypartners.com/my-sites/` and name it `split-scanner`.

## Files

| File | Purpose |
|------|---------|
| `scanner.js` | Node.js EDGAR scanner — runs server-side on GitHub |
| `splits.json` | Output — cumulative log of all splits found |
| `split-scanner-display.html` | Upload to CP artifacts hosting |
| `.github/workflows/scan.yml` | GitHub Actions schedule |
| `package.json` | Node dependencies |

## Schedule

Runs Monday–Friday at 9:00am ET (14:00 UTC). Also triggerable manually from the Actions tab.

## Data sources

- SEC EDGAR full-text search (`efts.sec.gov`)
- Form 8-K: stock split announcements
- Form 497: ETF prospectus supplements (ETF splits)
- Rolling 60-day lookback window on each scan
