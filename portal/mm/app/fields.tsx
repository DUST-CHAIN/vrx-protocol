"use client";

// Thin reusable form controls for the Structured editor. Dense, schema-driven look (§3 Face 1).
// Every control is uncontrolled-free (value-driven) and reports via onChange; parsing stays at the edge.

import type { ReactNode } from "react";

export function Field({
  label,
  hint,
  full,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`mm-field${full ? " mm-field--full" : ""}`}>
      <label>
        {label} {hint && <span className="hint">· {hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value ?? ""}
      placeholder={placeholder}
      style={mono ? { fontFamily: "var(--mono)" } : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  step,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value ?? ""}
      placeholder={placeholder}
      step={step}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === "" ? undefined : Number(raw));
      }}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return <textarea value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Comma-separated list <-> string[] (amenities etc.). */
export function ListInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[] | undefined;
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={(value || []).join(", ")}
      placeholder={placeholder || "comma, separated, values"}
      onChange={(e) =>
        onChange(
          e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        )
      }
    />
  );
}
