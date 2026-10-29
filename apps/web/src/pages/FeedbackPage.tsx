import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, errorMessage, post } from "../api.js";
import { CardSkeleton, ErrorAlert } from "../components.js";
import { BrandMark } from "../ui.js";
import type { FeedbackInfo } from "../types.js";

const RATING_LABELS: Record<number, string> = {
  1: "Very poor",
  2: "Poor",
  3: "Okay",
  4: "Good",
  5: "Excellent",
};

export function FeedbackPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [info, setInfo] = useState<FeedbackInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    api<FeedbackInfo>(`/feedback/${encodeURIComponent(token)}`)
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setRating(data.rating ?? 0);
        setComment(data.comment ?? "");
        setSubmitted(data.submitted);
      })
      .catch((caught) => {
        if (!cancelled) {
          const invalidLink =
            caught instanceof ApiError && [400, 404, 410].includes(caught.status);
          setError(invalidLink ? "This feedback link is invalid or has expired." : errorMessage(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (rating < 1) {
      setError("Please choose a rating.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/feedback/${encodeURIComponent(token)}`, { rating, comment: comment.trim() || undefined });
      setSubmitted(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <CardSkeleton label="Loading feedback form" />;

  return (
    <div className="center-page">
      <div className="card narrow">
        <BrandMark />
        <p className="eyebrow">{info ? info.tenantName : "OpsPilot"}</p>
        {!token ? (
          <>
            <h1>Feedback link missing</h1>
            <p className="muted">Open the link from your resolution email to rate your support experience.</p>
          </>
        ) : error && !info ? (
          <>
            <h1>Feedback unavailable</h1>
            <ErrorAlert message={error} />
          </>
        ) : submitted ? (
          <>
            <h1>Thanks for the feedback</h1>
            <p className="muted">
              {info ? `Ticket #${info.ticketNumber} · ${info.ticketSubject}` : "Your rating has been recorded."}
            </p>
            <div className="csat-score">
              <strong>{rating || info?.rating || "-"}</strong>
              <span className="stars" aria-hidden="true">
                {"★".repeat(rating || info?.rating || 0)}
                <span className="stars-empty">{"★".repeat(5 - (rating || info?.rating || 0))}</span>
              </span>
            </div>
            <p className="muted small">Your response helps the team improve.</p>
          </>
        ) : info ? (
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <h1>How did we do?</h1>
            <p className="muted">
              Ticket #{info.ticketNumber} · {info.ticketSubject}
            </p>
            <div className="star-picker" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`star-button${rating >= value ? " active" : ""}`}
                  role="radio"
                  aria-checked={rating === value}
                  aria-label={`${value} star${value === 1 ? "" : "s"}, ${RATING_LABELS[value]}`}
                  onClick={() => setRating(value)}
                >
                  ★
                </button>
              ))}
            </div>
            <p className="muted small">{rating ? RATING_LABELS[rating] : "Tap a star to rate"}</p>
            <label>
              Anything to add? <span className="muted small">(optional)</span>
              <textarea
                rows={4}
                maxLength={2000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Tell us what went well or what we could improve."
              />
            </label>
            <ErrorAlert message={error} />
            <button className="button" disabled={busy || rating < 1} type="submit">
              {busy ? "Sending…" : "Submit feedback"}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
