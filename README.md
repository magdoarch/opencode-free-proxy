# OpenCode Free Proxy

OpenAI-compatible serverless proxy ke OpenCode Free tier. Siap dideploy di Vercel secara gratis.

## Supported Free Models

| Model | Provider | Status | Catatan |
|---|---|:---:|---|
| `ling-3.1-flash-free` | Ling | ✅ Active | Chat completion cepat |
| `longcat-2.5-preview-free` | LongCat | ✅ Active | Long context support |
| `mimo-v2.6-flash-free` | Xiaomi MiMo | ✅ Active | Flagship lightweight reasoning |
| `muse-spark-1.3-contributor-free` | Muse | ✅ Active | Auto-routed ke `/responses` endpoint |
| `nemotron-3-ultra-free` | NVIDIA | ✅ Active | High-accuracy instruction following |
| `nemotron-3.5-lightning-free` | NVIDIA | ✅ Active | Ultra fast response |
| `space-bunny-free` | Space Bunny | ✅ Active | Balanced conversational |
| `step-5-preview-free` | Step | ✅ Active | Preview reasoning model |
| `fledge-alpha-free` | Fledge | ✅ Active | Experimental tier |
| `muse-spark-1.2-contributor-free` | Muse | ✅ Active | Stable response engine |

## Features

- **OpenAI-Compatible (`/v1/models`, `/v1/chat/completions`)**
- **Desktop Spoofing & Fingerprint Engine** (Bypass automated client checks OpenCode)
- **Automatic Routing** (Otomatis memilih endpoint `/chat/completions` atau `/responses` sesuai karakteristik model)
- **Streaming Support (SSE)**
- **Serverless & Edge Ready** (Ringan, tanpa external heavy dependencies)

## Deploy to Vercel

### 1. Autentikasi / Login Akun Vercel
Pastikan sudah login ke akun Vercel kamu sebelum melakukan deployment:

```bash
# Login interaktif (via browser / email / GitHub)
npx vercel login

# Atau jika di server/headless VPS (menggunakan token):
# Dapatkan token di: https://vercel.com/account/tokens
export VERCEL_TOKEN="your_vercel_token_here"
```

### 2. Deploy Project

```bash
# Clone repository
git clone https://github.com/magdoarch/opencode-free-proxy.git
cd opencode-free-proxy

# Deploy ke production (Interaktif)
npx vercel deploy --prod

# Atau deploy non-interaktif di CI/CD / headless server (menggunakan token):
npx vercel deploy --prod --token "$VERCEL_TOKEN" --yes
```

## Usage

```bash
# 1. List models
curl https://your-proxy.vercel.app/v1/models

# 2. Chat completion
curl https://your-proxy.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-flash-free",
    "messages": [{"role": "user", "content": "halo"}]
  }'
```

## License
MIT
