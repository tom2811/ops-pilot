import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

const ICONS = {
  ticket: (
    <>
      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" />
      <path d="M13 6v12" strokeDasharray="2 3" />
    </>
  ),
  reports: <path d="M4 19V10M9.5 19V5M15 19v-5M20 19v-8" />,
  email: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 14a4.5 4.5 0 0 1 3 5" />
    </>
  ),
  admin: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  audit: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9.5 12h6M9.5 16h6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  alert: (
    <>
      <path d="M12 4 21 20H3Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  account: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H5v16h4" />
      <path d="M13 8l4 4-4 4M17 12H9" />
    </>
  ),
  platform: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9h17M8 4.5v15" />
    </>
  ),
  arrowLeft: <path d="M19 12H5m0 0 6-6m-6 6 6 6" />,
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
      <path d="m15.5 9.5-3 2.5 3 2.5" />
    </>
  ),
  chevronLeft: <path d="m14 6-6 6 6 6" />,
  chevronRight: <path d="m10 6 6 6-6 6" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </>
  ),
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark${small ? " small" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
        <circle cx="9" cy="12" r="5" />
        <path d="M16 17V7h2.6a3.4 3.4 0 0 1 0 6.8H16" />
      </svg>
    </span>
  );
}

export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

type Theme = "light" | "dark";
const THEME_KEY = "opspilot.theme";

function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return {
    theme,
    toggleTheme: () => setTheme((current) => (current === "light" ? "dark" : "light")),
  };
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={onToggle}
      aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
      title={theme === "light" ? "Dark theme" : "Light theme"}
    >
      <Icon name={theme === "light" ? "moon" : "sun"} />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export type SelectOption = {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
};

type MenuPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = "Select an option",
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const baseId = useId().replace(/:/g, "");
  const listId = `${baseId}-listbox`;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const enabled = useMemo(
    () => options.map((option, index) => ({ option, index })).filter((entry) => !entry.option.disabled),
    [options],
  );

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = Math.min(280, options.length * 32 + 8);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const openAbove = below < Math.min(menuHeight, 180) && above > below;
    const maxHeight = Math.max(120, Math.min(280, openAbove ? above : below));
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const top = openAbove
      ? Math.max(8, rect.top - Math.min(menuHeight, maxHeight) - 5)
      : rect.bottom + 5;
    setPosition({ left, top, width, maxHeight });
  }, [options.length]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    reposition();
    const current = enabled.findIndex((entry) => entry.option.value === value);
    setActive(current >= 0 ? current : 0);
    setOpen(true);
  }, [disabled, enabled, reposition, value]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const handle = () => reposition();
    window.addEventListener("resize", handle);
    window.addEventListener("scroll", handle, true);
    return () => {
      window.removeEventListener("resize", handle);
      window.removeEventListener("scroll", handle, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const activeOption = menuRef.current?.querySelector<HTMLElement>(`[data-active="true"]`);
    activeOption?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function choose(index: number) {
    const entry = options[index];
    if (!entry || entry.disabled) return;
    onChange(entry.value);
    close(true);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActive((current) => Math.min(enabled.length - 1, current + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((current) => Math.max(0, current - 1));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(enabled.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const entry = enabled[active];
        if (entry) choose(entry.index);
        break;
      }
      default:
        break;
    }
  }

  let previousGroup: string | undefined;

  return (
    <div className={`select ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-activedescendant={open ? `${baseId}-option-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={`select-value ${selected ? "" : "select-placeholder"}`.trim()}>
          {selected?.label ?? placeholder}
        </span>
        <Icon name="chevron" className="select-chev icon-sm" />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            className="select-menu"
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={`${baseId}-option-${active}`}
            tabIndex={-1}
            style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.length === 0 && <div className="select-empty">No options</div>}
            {options.map((option, index) => {
              const showGroup = Boolean(option.group && option.group !== previousGroup);
              previousGroup = option.group;
              const activeIndex = enabled.findIndex((entry) => entry.index === index);
              return (
                <div key={`${option.group ?? ""}-${option.value}`}>
                  {showGroup && <div className="select-group">{option.group}</div>}
                  <button
                    type="button"
                    id={`${baseId}-option-${activeIndex}`}
                    data-active={activeIndex >= 0 && activeIndex === active}
                    className={`select-option ${activeIndex >= 0 && activeIndex === active ? "is-active" : ""}`.trim()}
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onMouseEnter={() => {
                      if (activeIndex >= 0) setActive(activeIndex);
                    }}
                    onClick={() => choose(index)}
                  >
                    <span>{option.label}</span>
                    {option.value === value && <Icon name="check" className="opt-check icon-sm" />}
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

export function Menu({
  label,
  ariaLabel,
  triggerTitle,
  triggerClassName = "icon-btn",
  children,
}: {
  label: ReactNode;
  ariaLabel?: string;
  triggerTitle?: string;
  triggerClassName?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={triggerClassName}
        aria-label={ariaLabel}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open && (
        <div className="menu" role="menu">
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

export function Sheet({
  open,
  onClose,
  eyebrow,
  title,
  description,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);

    const initial = panel?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0];
    (initial ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("sheet-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("sheet-open");
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="sheet-layer">
      <div
        className="sheet-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} tabIndex={-1}>
        <header className="sheet-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id={titleId}>{title}</h2>
            {description && <p className="sheet-desc">{description}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

type ToastTone = "success" | "danger" | "info";

type ToastItem = {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  duration: number | null;
  leaving?: boolean;
};

type ToastApi = {
  push: (input: { tone?: ToastTone; title: string; message?: string; duration?: number | null }) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);
const MAX_TOASTS = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      setToasts((current) =>
        current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)),
      );
      window.setTimeout(() => remove(id), 180);
    },
    [remove],
  );

  const push = useCallback<ToastApi["push"]>((input) => {
    counter.current += 1;
    const id = counter.current;
    const tone = input.tone ?? "success";
    const toast: ToastItem = {
      id,
      tone,
      title: input.title,
      message: input.message,
      duration: input.duration === undefined ? (tone === "danger" ? null : 6000) : input.duration,
    };
    setToasts((current) => [...current, toast].slice(-MAX_TOASTS));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, message) => push({ tone: "success", title, message }),
      error: (title, message) => push({ tone: "danger", title, message }),
      info: (title, message) => push({ tone: "info", title, message }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration ?? 0);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (toast.duration === null || remaining.current <= 0) return;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => onDismissRef.current(), remaining.current);
  }, [toast.duration]);

  useEffect(() => {
    start();
    return clear;
  }, [start, clear]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setPaused(true);
      else if (!document.hidden) setPaused(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (toast.duration === null) return;
    if (paused) {
      clear();
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    } else {
      start();
    }
    // Only react to pause changes; start/clear are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const interactivePause = (next: boolean) => {
    if (toast.leaving) return;
    setPaused(next);
  };

  return (
    <div
      className={`toast ${toast.leaving ? "is-leaving" : ""} ${toast.duration !== null && !paused && !toast.leaving ? "is-running" : "is-paused"}`.trim()}
      style={toast.duration !== null ? ({ "--toast-duration": `${toast.duration}ms` } as React.CSSProperties) : undefined}
      onMouseEnter={() => interactivePause(true)}
      onMouseLeave={() => interactivePause(false)}
      onFocus={() => interactivePause(true)}
      onBlur={() => interactivePause(false)}
      role={toast.tone === "danger" ? "alert" : "status"}
    >
      <span className={`toast-icon ${toast.tone}`}>
        <Icon name={toast.tone === "success" ? "check" : toast.tone === "danger" ? "alert" : "clock"} className="icon-sm" />
      </span>
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.message && <div className="toast-msg">{toast.message}</div>}
      </div>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss notification">
        <Icon name="x" className="icon-sm" />
      </button>
      {toast.duration !== null && (
        <div className="toast-timer" aria-hidden="true">
          <span />
        </div>
      )}
    </div>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}

/* ------------------------------------------------------------------ */
/* Confirmation dialog                                                 */
/* ------------------------------------------------------------------ */

type ConfirmOptions = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const settle = useCallback((answer: boolean) => {
    setRequest(null);
    resolver.current?.(answer);
    resolver.current = null;
  }, []);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setRequest(options);
      }),
    [],
  );

  useEffect(() => {
    if (!request) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [request, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request &&
        createPortal(
          <div
            className="dialog-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) settle(false);
            }}
          >
            <div
              className="dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={titleId}
              ref={panelRef}
            >
              <h2 id={titleId}>{request.title}</h2>
              {request.body && <p>{request.body}</p>}
              <div className="dialog-actions">
                <button ref={cancelRef} type="button" className="button secondary" onClick={() => settle(false)}>
                  {request.cancelLabel ?? "Cancel"}
                </button>
                <button
                  type="button"
                  className={`button ${request.tone === "danger" ? "danger" : ""}`.trim()}
                  onClick={() => settle(true)}
                >
                  {request.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error("useConfirm must be used inside ConfirmProvider");
  return context;
}
