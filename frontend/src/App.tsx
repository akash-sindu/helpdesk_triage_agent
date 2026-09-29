import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  Clock3,
  Headset,
  LoaderCircle,
  RotateCw,
  Send,
  ShieldCheck,
  Sparkles,
  TicketCheck,
} from "lucide-react";

type TicketStatus = "pending" | "resolved" | "escalated" | "error";

interface Ticket {
  ticketId: string;
  title: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt?: string;
}

interface TicketResponse extends Ticket {
  finalMessageToUser: string | null;
  citedArticleIds: string[];
  category: string | null;
  retrievedArticles: { articleId: string; title: string; score: number }[];
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const apiKey = import.meta.env.VITE_TICKET_API_KEY ?? "";

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function StatusLabel({ status }: { status: TicketStatus }) {
  const labels: Record<TicketStatus, string> = {
    pending: "Processing",
    resolved: "Resolved",
    escalated: "Escalated",
    error: "Needs attention",
  };
  return (
    <span className={`status status--${status}`}>
      <span className="status__dot" />
      {labels[status]}
    </span>
  );
}

export function App() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [response, setResponse] = useState<TicketResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingTickets, setIsLoadingTickets] = useState(true);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");

  async function refreshTickets() {
    if (!apiBaseUrl || !apiKey) {
      setIsLoadingTickets(false);
      return;
    }
    setIsLoadingTickets(true);
    setListError("");
    try {
      const result = await fetch(`${apiBaseUrl}/tickets`, {
        headers: { "x-api-key": apiKey },
      });
      if (!result.ok) throw new Error("Ticket list is unavailable.");
      const data = (await result.json()) as { tickets: Ticket[] };
      setTickets(data.tickets);
    } catch {
      setListError("Unable to load tickets. Check the API connection and retry.");
    } finally {
      setIsLoadingTickets(false);
    }
  }

  useEffect(() => {
    void refreshTickets();
  }, []);

  async function submitTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiBaseUrl || !apiKey) {
      setError("Set VITE_API_BASE_URL and VITE_TICKET_API_KEY in the root .env first.");
      return;
    }
    setIsSubmitting(true);
    setError("");
    setResponse(null);
    try {
      const result = await fetch(`${apiBaseUrl}/tickets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ title, description }),
      });
      const data = (await result.json()) as TicketResponse & { message?: string };
      if (!result.ok) throw new Error(data.message ?? "Ticket could not be submitted.");
      setResponse(data);
      setTitle("");
      setDescription("");
      await refreshTickets();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Ticket could not be submitted. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="IT Service Desk home">
          <span className="brand__mark"><Headset size={19} strokeWidth={2.2} /></span>
          <span className="brand__text">IT Service<span>DESK</span></span>
        </a>

        <div className="sidebar__section-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace">
          <a className="side-nav__item side-nav__item--active" href="#new-request">
            <TicketCheck size={17} />
            <span>New request</span>
            <ArrowUpRight className="side-nav__arrow" size={14} />
          </a>
          <a className="side-nav__item" href="#recent-tickets">
            <Clock3 size={17} />
            <span>Recent tickets</span>
          </a>
        </nav>

        <div className="sidebar__bottom">
          <div className="sidebar__rule" />
          <div className="service-status">
            <span className={`service-status__light ${apiBaseUrl && apiKey ? "is-connected" : ""}`} />
            <span>{apiBaseUrl && apiKey ? "Service connected" : "API not configured"}</span>
          </div>
          <div className="sidebar__caption">TRIAGE SYSTEM <span>DEMO</span></div>
        </div>
      </aside>

      <main id="top" className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span>/</span><strong>Help desk</strong></div>
          <div className="topbar__right"><span className="topbar__date">IT SUPPORT</span><span className="topbar__avatar">IT</span></div>
        </header>

        <div className="content-wrap">
          <section className="intro" aria-labelledby="page-title">
            <div className="intro__eyebrow"><span className="eyebrow-line" /> SERVICE REQUEST <span className="mono">/ 01</span></div>
            <h1 id="page-title">What can we<br className="intro__mobile-break" /> help you with<span>?</span></h1>
            <p>Tell us what’s going on. Your request will be reviewed and routed to the right place.</p>
            <div className="intro__index" aria-hidden="true"><span>01</span><span className="intro__index-line" /><span>02</span></div>
          </section>

          <section id="new-request" className="request-section" aria-labelledby="request-heading">
            <div className="section-heading">
              <div><span className="section-heading__number">01</span><h2 id="request-heading">Submit a request</h2></div>
              <span className="section-heading__note">USUALLY TAKES 2 MIN</span>
            </div>

            <div className="request-layout">
              <form className="request-form" onSubmit={submitTicket}>
                <label className="field">
                  <span className="field__label">Subject <span>REQUIRED</span></span>
                  <input
                    required
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="A short summary of the issue"
                    disabled={isSubmitting}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Description <span>REQUIRED</span></span>
                  <textarea
                    required
                    rows={5}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What happened? Include any details that might help us understand the issue."
                    disabled={isSubmitting}
                  />
                </label>
                {error && <p className="form-error" role="alert"><CircleAlert size={15} />{error}</p>}
                <div className="form-footer">
                  <span className="form-footer__privacy"><ShieldCheck size={15} /> Your request is logged securely</span>
                  <button className="submit-button" type="submit" disabled={isSubmitting}>
                    {isSubmitting ? <><LoaderCircle className="spin" size={16} /> Sending</> : <>Submit request <Send size={15} /></>}
                  </button>
                </div>
              </form>

              <aside className="request-aside" aria-label="Request details">
                <div className="aside-mark"><Sparkles size={18} /></div>
                <div className="request-aside__label">WHAT HAPPENS NEXT</div>
                <p>Your request is automatically reviewed. If it needs a closer look, it will be passed to the IT team.</p>
                <div className="aside-foot"><span>01—03</span><ArrowDownRight size={17} /></div>
              </aside>
            </div>
          </section>

          {isSubmitting && (
            <section className="processing" aria-live="polite">
              <span className="processing__icon"><LoaderCircle className="spin" size={18} /></span>
              <div><strong>Reviewing your request</strong><span>Checking the details and finding the right support.</span></div>
              <span className="processing__dots">···</span>
            </section>
          )}

          {response && !isSubmitting && (
            <section className={`response-panel response-panel--${response.status}`} aria-live="polite">
              <div className="response-panel__top">
                <div className="response-panel__status-icon">
                  {response.status === "resolved" ? <Check size={18} /> : <ArrowUpRight size={18} />}
                </div>
                <div className="response-panel__heading">
                  <div className="response-panel__eyebrow">REQUEST UPDATE <span>#{response.ticketId.slice(0, 8)}</span></div>
                  <h2>{response.status === "resolved" ? "Here’s what we found" : response.status === "error" ? "We hit a problem" : "Your request is with the IT team"}</h2>
                </div>
                {response.status === "resolved" && <span className="ai-tag"><Sparkles size={13} /> AI-GENERATED RESPONSE</span>}
              </div>
              <p className="response-panel__message">{response.finalMessageToUser}</p>
              {response.status === "resolved" && response.citedArticleIds.length > 0 && (
                <div className="response-panel__citations">KB REFERENCES {response.citedArticleIds.map((id) => <span key={id}>{id}</span>)}</div>
              )}
              <button className="text-button" onClick={() => setResponse(null)}>Close update <ArrowRight size={14} /></button>
            </section>
          )}

          <section id="recent-tickets" className="tickets-section" aria-labelledby="tickets-heading">
            <div className="section-heading section-heading--tickets">
              <div><span className="section-heading__number">02</span><h2 id="tickets-heading">Recent tickets</h2><span className="ticket-count">{tickets.length.toString().padStart(2, "0")}</span></div>
              <button className="refresh-button" onClick={() => void refreshTickets()} aria-label="Refresh ticket list" title="Refresh ticket list" disabled={isLoadingTickets || !apiBaseUrl || !apiKey}>
                <RotateCw className={isLoadingTickets ? "spin" : ""} size={16} />
              </button>
            </div>

            <div className="ticket-table" role="table" aria-label="Recent tickets">
              <div className="ticket-table__head" role="row">
                <span role="columnheader">SUBJECT</span><span role="columnheader">STATUS</span><span role="columnheader">SUBMITTED</span><span aria-hidden="true" />
              </div>
              {isLoadingTickets ? (
                <div className="table-state"><LoaderCircle className="spin" size={17} /> Loading tickets</div>
              ) : listError ? (
                <div className="table-state table-state--error"><CircleAlert size={17} />{listError}<button onClick={() => void refreshTickets()}>Retry</button></div>
              ) : tickets.length === 0 ? (
                <div className="table-empty"><span className="table-empty__icon"><TicketCheck size={19} /></span><strong>No tickets yet</strong><span>Submitted requests will appear here.</span></div>
              ) : tickets.slice(0, 8).map((ticket) => (
                <div className="ticket-row" role="row" key={ticket.ticketId}>
                  <div className="ticket-row__subject" role="cell"><span className="ticket-row__marker" />{ticket.title}</div>
                  <div role="cell"><StatusLabel status={ticket.status} /></div>
                  <time role="cell" dateTime={ticket.createdAt}>{formatDate(ticket.createdAt)}</time>
                  <ArrowUpRight className="ticket-row__arrow" size={15} aria-hidden="true" />
                </div>
              ))}
            </div>
            <div className="tickets-foot"><span>SHOWING LATEST {Math.min(tickets.length, 8).toString().padStart(2, "0")}</span><span>UPDATED ON SUBMISSION <span className="tickets-foot__arrow"><ArrowUpRight size={12} /></span></span></div>
          </section>

          <footer className="page-footer"><span>IT SERVICE DESK <span>·</span> TRIAGE DEMO</span><span>SUPPORT THAT STARTS WITH LISTENING.</span></footer>
        </div>
      </main>
    </div>
  );
}