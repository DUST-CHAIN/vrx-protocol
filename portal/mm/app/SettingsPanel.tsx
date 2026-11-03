"use client";

// Settings — AI keys (: "obvious where to do that + how to obtain one with a link"). A disclosure in the
// Frame holding the user's DeepSeek (text) + Gemini (images) keys, each with a short what-it's-for line, a GET-A-KEY
// link, and the reassurance that the key stays on this device (localStorage) and is sent only for the request. Keys
// are OPTIONAL — MM authors fully offline without them; they only unlock the AI generate + ✨ image features.

import { useKeys } from "./useKeys";

export function SettingsPanel() {
  const keys = useKeys();
  const have = (keys.deepseek ? 1 : 0) + (keys.gemini ? 1 : 0);

  return (
    <details className="mm-theme mm-settings">
      <summary className="mm-theme__summary">
        <span className="mm-theme__label">⚙ Settings · AI keys</span>
        <span className="mm-theme__current">
          {have === 0 ? "none set" : `${have} key${have > 1 ? "s" : ""}`}
        </span>
      </summary>
      <div className="mm-theme__body mm-settings__body">
        <p className="mm-settings__intro">
          Paste your own API keys to use the AI features. Keys stay on <b>this device</b> (your browser) and are sent
          only when you run that feature — never stored on a server. MM authors everything else without a key.
        </p>

        <KeyField
          label="DeepSeek key"
          what="Generates a building from a text brief (the ✦ New from AI feature)."
          value={keys.deepseek}
          onChange={keys.setDeepseek}
          placeholder="sk-…"
          getUrl="https://platform.deepseek.com/api_keys"
          getLabel="Get a DeepSeek key ↗"
        />

        <KeyField
          label="Gemini key"
          what="Generates unit & building images (the ✨ Generate buttons)."
          value={keys.gemini}
          onChange={keys.setGemini}
          placeholder="AI…"
          getUrl="https://aistudio.google.com/apikey"
          getLabel="Get a Gemini key (Google AI Studio) ↗"
        />
      </div>
    </details>
  );
}

function KeyField({
  label, what, value, onChange, placeholder, getUrl, getLabel,
}: {
  label: string; what: string; value: string; onChange: (v: string) => void;
  placeholder: string; getUrl: string; getLabel: string;
}) {
  return (
    <div className="mm-settings__key">
      <div className="mm-settings__keyhead">
        <span className="mm-settings__keylabel">{label}</span>
        {value
          ? <span className="mm-settings__keyok">✓ set</span>
          : <a className="mm-settings__getlink" href={getUrl} target="_blank" rel="noopener noreferrer">{getLabel}</a>}
      </div>
      <div className="mm-settings__what">{what}</div>
      <input
        type="password"
        className="mm-settings__input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {value && (
        <a className="mm-settings__getlink mm-settings__getlink--small" href={getUrl} target="_blank" rel="noopener noreferrer">{getLabel}</a>
      )}
    </div>
  );
}
