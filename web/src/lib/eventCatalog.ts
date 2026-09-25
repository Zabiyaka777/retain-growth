// Human-readable descriptions for the `events` types the platform actually
// writes. Enumerated from the source (every `from("events").insert`) rather
// than invented — an entry here for a type nothing emits would be a lie the
// operator can't act on.
//
// Severity mirrors the level each writer records today (error → critical,
// warn → warning, info → info), so the counter and the level filter can never
// disagree. It lives here anyway because severity is a product judgement about
// how alarming something is, and this is where it should be changed if one of
// those judgements turns out wrong.

export type Severity = 'critical' | 'warning' | 'info'

export interface EventDescriptor {
  title: string
  /** What it means in practice, and what the operator should do about it. */
  explanation: string
  severity: Severity
}

export const EVENT_CATALOG: Record<string, EventDescriptor> = {
  ai_credential_missing: {
    title: 'Немає ключа AI',
    explanation:
      'Лід дійшов до AI-вузла, але в організації не підключений ключ OpenRouter. AI мовчить — лід не отримує відповіді взагалі. Потрібно підключити ключ у Налаштуваннях → AI.',
    severity: 'critical',
  },
  ai_provider_error: {
    title: 'Збій AI-провайдера',
    explanation:
      'Запит до OpenRouter завершився помилкою (недоступність, ліміт, невірна модель). Конкретне повідомлення — у деталях. Лід лишився без відповіді на цей хід, але тред далі в AI-режимі.',
    severity: 'critical',
  },
  ai_empty_reply: {
    title: 'AI повернув порожню відповідь',
    explanation:
      'Модель відповіла порожнім текстом і не викликала жодного інструмента. Ліду нічого не надіслано. Часто означає задовгий контекст або невдалу модель у вузлі.',
    severity: 'critical',
  },
  ai_no_input: {
    title: 'Немає тексту для AI',
    explanation:
      'Прийшло повідомлення без тексту (найчастіше голосове, розшифровка якого не встигла або не вдалася). AI навмисно промовчав, замість відповідати на порожнечу.',
    severity: 'warning',
  },
  ai_exit_not_connected: {
    title: 'Вихід з AI-вузла не підключений',
    explanation:
      'AI вирішив вийти з вузла (потрібен менеджер, ліміт спроб, завдання виконані), але відповідна гілка у воронці нікуди не веде. Лід застряг на AI-вузлі — треба домалювати ребро у конструкторі.',
    severity: 'warning',
  },
  meta_capi_failed: {
    title: 'Meta відхилила конверсію',
    explanation:
      'Подію Conversions API не прийнято. Конверсія не потрапила в Ads Manager — оптимізація й атрибуція реклами по цьому ліду втрачені. Причина від Meta — у деталях.',
    severity: 'critical',
  },
  meta_capi_skipped: {
    title: 'Конверсію не надіслано',
    explanation:
      'Подію пропущено ще до звернення до Meta: немає pixel_id, токена, джерела ліда, або подія старша за 7 днів. Не помилка інтеграції — недостатньо налаштувань на посиланні.',
    severity: 'warning',
  },
  whatsapp_send_failed: {
    title: 'WhatsApp не надіслав повідомлення',
    explanation:
      'Cloud API відхилив відправку. Повідомлення не дійшло до ліда. Найчастіше — прострочений токен або проблема з номером.',
    severity: 'critical',
  },
  whatsapp_window_closed: {
    title: 'Вікно 24 години закрите',
    explanation:
      'Спроба надіслати вільний текст пізніше ніж через 24 години після повідомлення ліда. Відправку зупинено навмисно — за правилами WhatsApp потрібен затверджений шаблон.',
    severity: 'warning',
  },
  transcription_failed: {
    title: 'Не вдалося розшифрувати голосове',
    explanation:
      'Помилка при завантаженні аудіо або на боці моделі. Саме голосове збережене й доступне для прослуховування, але тексту під ним не буде.',
    severity: 'warning',
  },
  transcription_skipped: {
    title: 'Розшифровку пропущено',
    explanation:
      'Голосове не розшифровувалось, бо в організації немає ключа OpenRouter. Повідомлення збережене, транскрипту не буде, доки ключ не підключать.',
    severity: 'warning',
  },
  button_edge_not_connected: {
    title: 'Кнопка нікуди не веде',
    explanation:
      'Лід натиснув кнопку, для якої у воронці не проведено ребро. Воронку завершено на цьому вузлі — лід далі нічого не отримає. Домалюйте гілку від цієї кнопки в конструкторі.',
    severity: 'critical',
  },
  landing_publish_blocked: {
    title: 'Публікацію лендінга заблоковано',
    explanation:
      'Організація спробувала опублікувати сторінку з фразами фейкових «перевірок» (Win+R, PowerShell, «вставте в термінал» тощо) — так роблять атаки, що змушують відвідувача запустити шкідливу команду. Сторінка лишилась чернеткою; які саме фрази — у деталях. Якщо таких спроб кілька від однієї організації, варто перевірити акаунт.',
    severity: 'warning',
  },
  landing_unpublished_by_admin: {
    title: 'Лендінг знято з публікації адміном',
    explanation:
      'Адміністратор платформи зняв опубліковану сторінку, яку фільтр позначив як підозрілу. Вона стала чернеткою; лінки на неї ведуть одразу в месенджер. Хто це зробив — у журналі дій адмінів.',
    severity: 'warning',
  },
  blocked_lead_ignored: {
    title: 'Заблокований лід — відповідь стримано',
    explanation:
      'Повідомлення від заблокованого чи архівного ліда записане в тред, але автоматичної відповіді не надіслано. Штатна поведінка, не збій.',
    severity: 'info',
  },
  multiple_ai_active_states: {
    title: 'Лід одночасно в кількох AI-розмовах',
    explanation:
      'У ліда є більше одного активного AI-вузла одночасно — в різних воронках. Відповідь піде в останню з них, куди він потрапив; помилки це не спричиняє, але варто перевірити в профілі ліда, чи не варто відключити зайву воронку.',
    severity: 'warning',
  },
  multiple_active_funnel_states: {
    title: 'Лід одночасно в кількох активних воронках',
    explanation:
      'У ліда є більше одного активного (не-AI) стану воронки одночасно — в різних воронках. Клік по кнопці не несе інформації, якій саме воронці він належить, тож просувається найновіший стан, куди лід потрапив. Помилки це не спричиняє, але варто перевірити в профілі ліда, чи не варто зупинити зайву воронку.',
    severity: 'warning',
  },
}

const SEVERITY_BY_LEVEL: Record<string, Severity> = {
  error: 'critical',
  warn: 'warning',
  info: 'info',
}

/**
 * Falls back gracefully for a type added later than this catalog: the raw type
 * is still shown and coloured by the row's own level, so a new event is never
 * invisible just because nobody wrote a description for it yet.
 */
export function describeEvent(type: string, level: string): EventDescriptor {
  const known = EVENT_CATALOG[type]
  if (known) return known

  return {
    title: type,
    explanation: 'Опис для цього типу події ще не додано.',
    severity: SEVERITY_BY_LEVEL[level] ?? 'info',
  }
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'критичних',
  warning: 'попереджень',
  info: 'інфо',
}
