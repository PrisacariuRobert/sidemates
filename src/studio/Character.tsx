import { useId, useSyncExternalStore, type CSSProperties } from "react";
import { mascotBodies } from "./mascot-catalog";
import type { MascotKind } from "../shared/types";

/** Teammates that have their own picture, by name, filled in once from the
 * studio state. Every face draws through Character, so this is the one place
 * that decides picture or mascot. */
let avatars: Record<string, string> = {};
const avatarListeners = new Set<() => void>();
export function setAvatars(next: Record<string, string>) {
  if (JSON.stringify(next) === JSON.stringify(avatars)) return;
  avatars = next;
  avatarListeners.forEach((listener) => listener());
}
const subscribeAvatars = (listener: () => void) => { avatarListeners.add(listener); return () => { avatarListeners.delete(listener); }; };
const readAvatars = () => avatars;

/** Original animated vector family; shared by desktop and phones. */
export function Character({
  name,
  color,
  variant = "nova",
  size = 36,
  status = "ready",
  mood = "calm",
  avatar,
}: {
  name: string;
  color: string;
  variant?: string;
  size?: number;
  status?: string;
  mood?: "calm" | "curious" | "focused" | "happy";
  /** Overrides the lookup by name, e.g. for a preview before it is saved. `null` forces the mascot. */
  avatar?: string | null;
}) {
  const id = useId().replaceAll(":", "");
  const known = useSyncExternalStore(subscribeAvatars, readAvatars, readAvatars)[name];
  const picture = avatar === undefined ? known : avatar;
  const seed = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const shape = Object.hasOwn(mascotBodies, variant)
    ? (variant as MascotKind)
    : "nova";
  if (picture) {
    return (
      <span
        className={`character character-avatar character-${status}`}
        role="img"
        aria-label={`${name}, ${status}`}
        style={{ width: size, height: size }}
      >
        <img src={picture} alt="" width={size} height={size} draggable={false} />
      </span>
    );
  }
  return (
    <svg
      className={`character character-${status} character-mood-${mood}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`${name}, ${status}`}
      data-shape={shape}
      style={
        {
          "--character-color": /^#[0-9a-f]{6}$/i.test(color)
            ? color
            : "#7064cf",
          "--blink-delay": `${-(seed % 53) / 10}s`,
          "--blink-duration": `${4.7 + (seed % 7) / 4}s`,
          "--float-delay": `${-(seed % 19) / 10}s`,
        } as CSSProperties
      }
    >
      <defs>
        <linearGradient id={`${id}body`} x1="0" y1="0" x2=".8" y2="1">
          <stop stopColor="white" stopOpacity=".26" />
          <stop offset=".52" stopColor="white" stopOpacity="0" />
          <stop offset="1" stopColor="black" stopOpacity=".13" />
        </linearGradient>
      </defs>
      <g className="character-drawing">
        {shape === "nova" && (
          <g fill="var(--character-color)">
            <path d="M48 29V17h4v12Z" />
            <circle cx="50" cy="13" r="5" />
            <rect x="9" y="45" width="12" height="22" rx="6" />
            <rect x="79" y="45" width="12" height="22" rx="6" />
          </g>
        )}
        {shape === "sprout" && (
          <g fill="var(--character-color)">
            <path d="M49 30C24 29 22 6 29 7C42 9 49 19 49 30Z" />
            <path d="M51 30C76 28 78 7 70 8C58 10 51 20 51 30Z" />
          </g>
        )}
        {shape === "sunny" && (
          <g
            stroke="var(--character-color)"
            strokeWidth="6"
            strokeLinecap="round"
          >
            {Array.from({ length: 8 }, (_, n) => (
              <path
                key={n}
                d="M50 12v7"
                transform={`rotate(${n * 45} 50 56)`}
              />
            ))}
          </g>
        )}
        {shape === "orbit" && (
          <ellipse
            cx="50"
            cy="56"
            rx="43"
            ry="14"
            transform="rotate(-24 50 56)"
            fill="none"
            stroke="var(--character-color)"
            strokeWidth="6"
            opacity=".75"
          />
        )}
        <path
          className="character-body"
          d={mascotBodies[shape]}
          fill="var(--character-color)"
        />
        <path
          d={mascotBodies[shape]}
          fill={`url(#${id}body)`}
          stroke="black"
          strokeOpacity=".09"
        />
        <path
          d={shape === "pebble" ? "M39 38q8-6 17-3" : "M30 40q9-10 22-9"}
          stroke="white"
          strokeOpacity=".33"
          strokeWidth="2.8"
          fill="none"
          strokeLinecap="round"
        />
        <g className="character-eyes" fill="#24242b">
          {mood === "happy" ? (
            <g
              fill="none"
              stroke="#24242b"
              strokeWidth="2.6"
              strokeLinecap="round"
            >
              <path d="M36 55q4-7 8 0" />
              <path d="M57 55q4-7 8 0" />
            </g>
          ) : (
            <>
              <ellipse
                cx={mood === "curious" ? 42 : 40}
                cy="54"
                rx="3.3"
                ry={mood === "focused" ? 3 : 4.7}
              />
              <ellipse
                cx={mood === "curious" ? 63 : 61}
                cy="54"
                rx="3.3"
                ry={mood === "focused" ? 3 : 4.7}
              />
            </>
          )}
        </g>
        {mood === "curious" && (
          <path
            d="M57 43q5-3 9 0"
            fill="none"
            stroke="#24242b"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        )}
        <path
          className="character-smile"
          d={
            mood === "happy"
              ? "M43 64q7 12 15 0Z"
              : mood === "focused"
                ? "M47 66h8"
                : "M45 65q6 5 12-1"
          }
          fill="none"
          stroke="#24242b"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <ellipse cx="30" cy="64" rx="4" ry="2" fill="white" opacity=".17" />
        <ellipse cx="71" cy="64" rx="4" ry="2" fill="white" opacity=".17" />
        {shape === "orbit" && (
          <path
            d="M13 69C28 78 64 67 85 45"
            fill="none"
            stroke="var(--character-color)"
            strokeWidth="5"
            strokeLinecap="round"
          />
        )}
      </g>
    </svg>
  );
}
