import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Disable body parser — we need raw body for signature verification
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const rawBody  = await getRawBody(req);
    const signature = req.headers['x-razorpay-signature'];

    // ── Verify webhook signature ──────────────────────────────────────
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSig) {
      console.error('Webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = JSON.parse(rawBody);
    const sb    = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Plan ID → plan name mapping
    const planMap = {
      [process.env.RAZORPAY_STARTER_PLAN_ID]: 'starter',
      [process.env.RAZORPAY_TEAM_PLAN_ID]:    'team'
    };

    console.log('Razorpay webhook event:', event.event);

    switch (event.event) {

      // ── Subscription activated / payment successful ─────────────────
      case 'subscription.activated':
      case 'subscription.charged': {
        const sub    = event.payload.subscription.entity;
        const plan   = planMap[sub.plan_id];
        const userId = sub.notes?.user_id;

        if (!userId || !plan) {
          console.warn('Missing user_id or plan in subscription notes:', sub.notes);
          break;
        }

        await sb.auth.admin.updateUserById(userId, {
          user_metadata: {
            plan,
            razorpay_subscription_id: sub.id,
            plan_activated_at: new Date().toISOString()
          }
        });

        await sb.from('profiles').upsert({
          id:                       userId,
          plan,
          razorpay_subscription_id: sub.id,
          pending_plan:             null,
          plan_activated_at:        new Date().toISOString(),
          updated_at:               new Date().toISOString()
        }, { onConflict: 'id' });

        console.log(`Plan activated: ${userId} → ${plan}`);
        break;
      }

      // ── Subscription cancelled / completed / payment failed ─────────
      case 'subscription.cancelled':
      case 'subscription.completed':
      case 'subscription.halted': {
        const sub    = event.payload.subscription.entity;
        const userId = sub.notes?.user_id;

        if (!userId) {
          console.warn('Missing user_id in subscription notes:', sub.notes);
          break;
        }

        await sb.auth.admin.updateUserById(userId, {
          user_metadata: {
            plan:                     'free',
            razorpay_subscription_id: null,
            plan_cancelled_at:        new Date().toISOString()
          }
        });

        await sb.from('profiles').upsert({
          id:                       userId,
          plan:                     'free',
          razorpay_subscription_id: null,
          updated_at:               new Date().toISOString()
        }, { onConflict: 'id' });

        console.log(`Plan reverted to free: ${userId} (event: ${event.event})`);
        break;
      }

      default:
        console.log('Unhandled webhook event:', event.event);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
