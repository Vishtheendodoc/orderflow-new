# OrderFlow Engine

Real-time footprint chart + delta + CVD powered by Dhan API.

```
Tick Classification → Footprint Candles → Delta Bars → CVD Line
```

---

## Features

- **Footprint chart** — bid/ask volume at every price level per candle
- **Imbalance detection** — highlights levels where buy/sell ratio ≥ 3×
- **Delta bars** — per-candle buy vol − sell vol
- **CVD line** — cumulative volume delta (trend of aggression)
- **Lee-Ready tick rule** — classifies every trade as buyer or seller initiated
- **Demo mode** — works without Dhan credentials (synthetic data)
- **Multi-symbol** — watch Nifty, BankNifty, FinNifty simultaneously

---

## Local Development

### 1. Backend

```bash
cd backend
cp .env.example .env
# Add your Dhan CLIENT_ID and ACCESS_TOKEN to .env

pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173
```

### 3. Subscribe to a symbol

In the sidebar, click any preset (Nifty/BankNifty) or enter:
- **Symbol**: `NIFTY25MARFUT`
- **Security ID**: `13` (get from Dhan's instrument master CSV)

---

## Deploy to Render

### Option A — render.yaml (recommended)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your repo — Render will read `render.yaml` and create both services
4. Add env vars in the Render dashboard:
   - `DHAN_CLIENT_ID` → your Dhan client ID
   - `DHAN_ACCESS_TOKEN` → your Dhan access token
5. Update `render.yaml` → set `VITE_WS_URL` and `VITE_API_URL` to your actual backend URL

### Option B — manual

**Backend (Web Service)**
- Runtime: Python 3.11
- Root dir: `backend`
- Build: `pip install -r requirements.txt`
- Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Env vars: `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN`

**Frontend (Static Site)**
- Root dir: `frontend`
- Build: `npm install && npm run build`
- Publish dir: `dist`
- Env: `VITE_WS_URL=wss://<your-backend>.onrender.com/ws`
- Env: `VITE_API_URL=https://<your-backend>.onrender.com`

---

## Dhan API Notes

### Getting Security IDs

Download the Dhan instrument master:
```
https://images.dhan.co/api-data/api-scrip-master.csv
```

Search for your symbol (e.g. `NIFTY25MARFUT`) and note the `SEM_SMST_SECURITY_ID`.

### WebSocket Feed Format

The backend handles Dhan's v2 market feed format. It expects:
```json
{ "data": { "securityId": "13", "LTP": 22500.5, "BidPrice": 22500.0, "AskPrice": 22501.0, "volume": 150 } }
```

If Dhan changes their feed format, update `handle_dhan_tick()` in `backend/main.py`.

---

## Candle Granularity

Change via env var:
```
CANDLE_SECONDS=60   # 1-minute footprint
CANDLE_SECONDS=300  # 5-minute footprint
```

## Price Tick Grid

Default is 0.05 (fine enough for Nifty). Change in `main.py`:
```python
rounded_price = round(ltp * 20) / 20  # 0.05 grid
rounded_price = round(ltp * 4) / 4    # 0.25 grid (coarser)
```

---

## Architecture

```
Dhan WebSocket Feed
        │
        ▼
  FastAPI Backend
  ├── Tick classifier (tick rule + Lee-Ready)
  ├── FootprintCandle builder
  ├── Delta / CVD accumulator
  └── WS broadcast to all clients
        │
        ▼
  React Frontend
  ├── Footprint columns (price ladder)
  ├── Delta bars per candle
  ├── CVD sparkline
  └── Live ticker bar
```
