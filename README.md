# RPGLens — IBM i Code Intelligence Platform

AI-powered RPG code analyser. Paste or upload any IBM i / RPG source code and get:
- Plain-English explanation
- Structured documentation (Word/PDF export)
- Risk analysis with severity ratings
- Modernisation roadmap

## Pages
- `/` — Landing page
- `/analyser` — The analysis tool 

## Tech stack
- Pure HTML/CSS/JS — no framework, no build step
- Claude API (Anthropic) for AI analysis
- Hosted on Vercel (free tier)

## Deployment
1. Push this folder to a GitHub repository
2. Connect the repo to Vercel at vercel.com
3. Deploy — done. No build configuration needed.

## Environment
No environment variables needed for V1.
Users supply their own Anthropic API key in the tool UI.
(Step 3 of the roadmap adds a backend proxy to handle this server-side.)

## Local development
Just open index.html in a browser. No server needed.
