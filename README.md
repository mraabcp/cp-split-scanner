# CP Split Scanner

Daily stock and ETF split calendar for Cerity Partners, powered by the Polygon.io (Massive) API.

## How it works

1. GitHub Actions runs `scanner.js` every weekday at 9am ET
2. Scanner calls the Polygon.io splits API for all splits with execution dates within 7 days back and 30 days forward
3. Company names are enriched via Yahoo Finance
4. Results written to `splits.json` and committed to this repo
5. `split-scanner-display.html` (hosted on artifacts.ceritypartners.com) reads the JSON and renders the table

## Data source

**Polygon.io / Massive** — `api.polygon.io/v3/reference/splits`

Covers all US-listed stocks and ETFs. Returns ticker, execution date, split_from, and split_to. Forward/reverse type is derived from the ratio. Company names and ETF classification resolved via Yahoo Finance search API.

## Setup

### 1. API key

A Massive (Polygon.io) API key is required. Store it as a GitHub repository secret named `POLYGON_API_KEY`:

Settings → Secrets and variables → Actions → New repository secret

### 2. Make the repo public

The display HTML fetches `splits.json` from the raw GitHub URL, which requires the repo to be public.

### 3. Schedule

The workflow runs Monday–Friday at 9am ET (14:00 UTC). It can also be triggered manually from the Actions tab.

## Files

| File | Description |
|------|-------------|
| `scanner.js` | Main scanner script — fetches splits from Polygon, enriches with Yahoo Finance, writes `splits.json` |
| `splits.json` | Output data file read by the display page |
| `package.json` | Node.js dependencies (`node-fetch`) |
| `.github/workflows/scan.yml` | GitHub Actions workflow |
| `split-scanner-display.html` | Hosted display page (upload to artifacts.ceritypartners.com) |

## Display page features

- Forward / reverse / ETF filters and ticker search
- Sortable columns
- **Impact to Accounts** — upload any holdings CSV, map ticker and account columns, and instantly see which accounts hold positions with upcoming splits
- Export impacted accounts to CSV

## splits.json schema

```json
{
  "lastUpdated": "ISO timestamp",
  "totalRecords": 67,
  "splits": [
    {
      "id": "unique-id",
      "ticker": "VGT",
      "company": "Vanguard Information Technology ETF",
      "exDate": "2026-04-21",
      "ratio": "8-for-1",
      "type": "forward",
      "isETF": true,
      "source": "polygon"
    }
  ]
}
```
