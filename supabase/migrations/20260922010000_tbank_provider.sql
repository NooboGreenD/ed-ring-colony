-- T-Bank hosted one-stage payments. No credentials in migrations.
INSERT INTO public.payment_providers (id, name, is_enabled, test_mode, methods, display_order)
VALUES ('tbank', 'Т-Банк', false, true, ARRAY['card'], 5)
ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN public.payment_intents.status IS
  'pending, processing (atomically claimed; stalled fulfilment requires reconciliation), paid, failed, canceled, expired';
