import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://rpglens.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Session expired.' });

    const subscriptionId = user.user_metadata?.razorpay_subscription_id;
    if (!subscriptionId) return res.status(400).json({ error: 'No active subscription found.' });

    const rzp = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    // cancel_at_cycle_end=1 means they keep access until end of current billing period
    await rzp.subscriptions.cancel(subscriptionId, true);

    return res.status(200).json({ success: true, message: 'Subscription cancelled. Access continues until end of current billing period.' });

  } catch (err) {
    console.error('cancel-subscription error:', err);
    return res.status(500).json({ error: err.message || 'Failed to cancel subscription.' });
  }
}
