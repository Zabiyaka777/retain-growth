import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

// Payments taken through an org's own Plata by Mono (payments table, read via RLS).

export interface PaymentRow {
  id: string
  status: 'created' | 'processing' | 'hold' | 'success' | 'failure' | 'reversed' | 'expired'
  amount: number
  final_amount: number | null
  destination: string | null
  page_url: string | null
  test_mode: boolean
  failure_reason: string | null
  created_at: string
  paid_at: string | null
}

export const PAYMENT_STATUS: Record<PaymentRow['status'], { label: string; tone: string }> = {
  created: { label: 'Очікує оплати', tone: 'wait' },
  processing: { label: 'Обробляється', tone: 'wait' },
  hold: { label: 'Кошти заблоковано', tone: 'wait' },
  success: { label: 'Оплачено', tone: 'ok' },
  failure: { label: 'Не вдалося', tone: 'bad' },
  reversed: { label: 'Повернено', tone: 'bad' },
  expired: { label: 'Прострочено', tone: 'muted' },
}

export function formatUah(minor: number): string {
  return `${(minor / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} грн`
}

/** Invoices for one thread (or lead), live via Realtime. */
export function usePayments(filter: { threadId?: string; leadId?: string }) {
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const key = filter.threadId ?? filter.leadId ?? ''
  const column = filter.threadId ? 'thread_id' : 'lead_id'

  const load = useCallback(async () => {
    if (!key) return
    const { data } = await supabase
      .from('payments')
      .select('id, status, amount, final_amount, destination, page_url, test_mode, failure_reason, created_at, paid_at')
      .eq(column, key)
      .order('created_at', { ascending: false })
      .limit(20)
    setPayments((data ?? []) as PaymentRow[])
  }, [key, column])

  useEffect(() => {
    void load()
    if (!key) return
    const channel = supabase
      .channel(`payments-${column}-${key}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments', filter: `${column}=eq.${key}` }, () => void load())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [load, key, column])

  return { payments, reload: load }
}
