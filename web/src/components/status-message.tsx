"use client";

export type StatusType = "pending" | "success" | "error";

interface StatusMessageProps {
  type: StatusType;
  message: string;
}

const styles: Record<StatusType, string> = {
  pending:
    "border-warning/30 bg-warning/5 text-warning",
  success:
    "border-success/30 bg-success/5 text-success",
  error:
    "border-error/30 bg-error/5 text-error",
};

const icons: Record<StatusType, string> = {
  pending: "\u23F3", // hourglass
  success: "\u2714", // checkmark
  error: "\u2718",   // X
};

export function StatusMessage({ type, message }: StatusMessageProps) {
  return (
    <div className={`rounded-lg border p-3 text-sm ${styles[type]}`}>
      <span className="mr-2">{icons[type]}</span>
      {message}
    </div>
  );
}
