import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const PLAN_LIMITS = { free: 3, starter: 25, team: 150, admin: 999999 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://rpglens.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Auth ─────────────────────────────────────────────────────────
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    const plan = user.user_metadata?.plan || 'free';
    const limit = PLAN_LIMITS[plan] || 3;

    // ── Usage check ───────────────────────────────────────────────────
    if (plan !== 'admin') {
      const periodStart = new Date();
      periodStart.setDate(periodStart.getDate() - 30);

      const { count } = await sb
        .from('usage')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', periodStart.toISOString());

      if (count >= limit) {
        return res.status(429).json({
          error: `You have used all ${limit} analyses in your current billing period.`,
          upgrade: plan !== 'team'
        });
      }
    }

    const { brdText, projectName } = req.body;
    if (!brdText || brdText.trim().length < 50) {
      return res.status(400).json({ error: 'BRD content is too short. Please provide a detailed business requirements document.' });
    }

    // ── Generate TDD ──────────────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are a senior IBM i systems architect with 20+ years of experience designing IBM i / AS400 solutions using RPG, CL, DDS, and DB2 for i.

A business analyst has provided the following Business Requirements Document (BRD). Your task is to produce a detailed, IBM i-specific Technical Design Document (TDD) that a developer can use to build the solution.

Project name: ${projectName || 'Unnamed Project'}

BRD CONTENT:
${brdText}

Produce a comprehensive TDD with these exact sections:

## 1. PROJECT OVERVIEW
Restate the business objective in technical terms. Identify the IBM i components required. State assumptions made.

## 2. PROGRAM SPECIFICATIONS
For each program required, provide:
### [PROGRAM NAME] — [Program type: RPG/SQLRPG/CL]
- **Purpose:** What this program does
- **Trigger:** How it is called (batch job, interactive, called program, scheduled)
- **Input parameters:** List with data type and length
- **Output parameters:** List with data type and length
- **Processing overview:** Step-by-step logic description
- **Called programs:** Other programs this calls
- **Error handling:** How errors are managed

## 3. FILE & DATABASE DESIGN
For each file/table required:
### [FILE NAME]
- **Type:** Physical File / Logical File / SQL Table / View
- **Purpose:** What data it holds
- **DDS / DDL source:** Provide the actual DDS source or SQL CREATE TABLE statement
- **Key fields:** Primary key and access paths
- **Estimated volume:** Approximate number of records

## 4. DATA STRUCTURES & KEY FIELDS
List all major data structures (DS) that will be used across programs. Include field names, types, and lengths in a table format:
| DS Name | Field Name | Type | Length | Decimal | Description |

## 5. JOB & CL FLOW
Describe the overall job flow:
- CL programs required
- SBMJOB parameters
- Job queue recommendations
- Sequence of program calls
- MONMSG requirements

## 6. SCREEN / REPORT DESIGN (if applicable)
For any display files or printer files:
- Screen/report name and purpose
- Key fields displayed
- User interactions

## 7. ERROR HANDLING STRATEGY
- Error codes and messages to be used
- MONMSG CPF codes
- Logging approach
- User notification method

## 8. TEST SCENARIOS
Provide at least 5 specific test scenarios with input data and expected output.

## 9. OPEN QUESTIONS & ASSUMPTIONS
List any ambiguities in the BRD that need clarification before development begins.

## 10. ESTIMATED EFFORT
Provide a realistic development effort estimate broken down by component:
| Component | Type | Estimated Hours | Complexity |

Be specific and IBM i focused. Use actual RPG field naming conventions (max 10 chars for DDS, max 15 for SQL). Use IBM i terminology throughout.`;

    const response = await client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 8000,
      messages:   [{ role: 'user', content: prompt }]
    });

    const tdd = response.content[0].text;

    // ── Log usage ─────────────────────────────────────────────────────
    await sb.from('usage').insert({
      user_id:    user.id,
      type:       'analysis',
      subtype:    'brd-tdd',
      created_at: new Date().toISOString()
    });

    return res.status(200).json({ tdd, projectName: projectName || 'Unnamed Project' });

  } catch (err) {
    console.error('brd-tdd error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate TDD.' });
  }
}
