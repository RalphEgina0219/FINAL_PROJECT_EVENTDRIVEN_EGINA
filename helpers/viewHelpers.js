/*
 * Handlebars helpers for .xian templates. Every helper that returns HTML escapes its input
 * with Handlebars.escapeExpression before wrapping it in a SafeString.
 */
import {
  STATUS_LABELS, STATUS_BADGES, STATUS_HINTS, PRIORITY_LABELS, PRIORITY_BADGES,
  CASE_TYPE_LABELS, ROLE_LABELS, HISTORY_FIELD_LABELS, ESCALATION_LEVEL_LABELS, EMPLOYMENT_STATUS_LABELS, historyValueLabel,
} from "./labels.js";
import { formatDate, formatDateTime, timeAgo, formatDuration } from "./dates.js";

// Heroicons (outline, MIT license) path data.
const ICONS = {
  home: "m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25",
  ticket: "M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z",
  star: "M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z",
  users: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z",
  headset: "M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155",
  tag: "M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3ZM6 6h.008v.008H6V6Z",
  cog: "M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75",
  chart: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z",
  document: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z",
  bell: "M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0",
  key: "M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z",
  list: "M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z",
  download: "M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3",
  user: "M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z",
  plus: "M12 4.5v15m7.5-7.5h-15",
  logout: "M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9",
  menu: "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5",
  x: "M6 18 18 6M6 6l12 12",
  clock: "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  paperclip: "m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13",
  search: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
  check: "m4.5 12.75 6 6 9-13.5",
  "arrow-left": "M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18",
  info: "m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z",
  lock: "M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z",
  warning: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z",
  eye: "M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  beaker: "M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23-.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5",
  cart: "M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z",
  megaphone: "M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 0 1-1.44-4.282m3.102.069a18.03 18.03 0 0 1-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 0 1 8.835 2.535M10.34 6.66a23.847 23.847 0 0 0 8.835-2.535m0 0A23.74 23.74 0 0 0 18.795 3m.38 1.125a23.91 23.91 0 0 1 1.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 0 0 1.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 0 1 0 3.46",
  arrowUp: "M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18",
  inbox: "M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z",
  question: "M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z",
  truck: "M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 0 0-10.026 0 1.106 1.106 0 0 0-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12",
  chat: "M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z",
  // Added for the JVz look (header menu, auth forms, stat cards, compliance card).
  chevronDown: "m19.5 8.25-7.5 7.5-7.5-7.5",
  shieldCheck: "M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z",
  trendUp: "M2.25 18 9 11.25l4.306 4.306a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941",
  arrowRight: "M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3",
  eyeSlash: "M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88",
  envelope: "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75",
  checkCircle: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  phone: "M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z",
};

// Stat cards (partials/stat.xian) pick an icon and a colour from the page they link to, so the ~110 existing
// {{> stat}} calls get the new look without being edited. A call can still pass icon= and tone= to override.
const STAT_ICONS = [
  [/\/(escalations)/, "arrowUp", "rose"],
  [/\/(approvals)/, "document", "iris"],
  [/\/(follow-ups)/, "clock", "amber"],
  [/\/(inquiries)/, "question", "sky"],
  [/\/(sales|orders|shop|refunds|payments)/, "cart", "green"],
  [/\/(campaigns|promotions)/, "megaphone", "iris"],
  [/\/(loyalty)/, "star", "amber"],
  [/\/(customers|staff|team-performance|segments)/, "users", "blue"],
  [/\/(cases|queue|complaints)/, "ticket", "iris"],
  [/\/(analytics|reports|forecasts)/, "chart", "blue"],
  [/\/(integration|reconciliation|categories|templates|audit)/, "cog", "sky"],
  [/\/(interactions)/, "chat", "sky"],
];
const STAT_TONES = {
  blue: { bg: "bg-brand-600", decor: "text-brand-100" },
  green: { bg: "bg-emerald-500", decor: "text-emerald-100" },
  iris: { bg: "bg-iris-500", decor: "text-iris-100" },
  amber: { bg: "bg-amber-500", decor: "text-amber-100" },
  rose: { bg: "bg-rose-500", decor: "text-rose-100" },
  sky: { bg: "bg-sky-500", decor: "text-sky-100" },
};
const statMeta = (href, icon, tone, alert) => {
  const hit = STAT_ICONS.find(([re]) => re.test(String(href || "")));
  const name = typeof icon === "string" && icon ? icon : hit ? hit[1] : "chart";
  const t = alert && !(Array.isArray(alert) && !alert.length) ? "rose" : (typeof tone === "string" && STAT_TONES[tone] ? tone : hit ? hit[2] : "blue");
  return { icon: ICONS[name] ? name : "chart", ...STAT_TONES[t] };
};

export const registerViewHelpers = (hbs) => {
  const H = hbs.handlebars;
  const esc = H.escapeExpression;
  const safe = (html) => new H.SafeString(html);
  const args = (list) => list.slice(0, -1); // drop the Handlebars options object

  hbs.registerHelper("eq", (a, b) => String(a) === String(b));
  hbs.registerHelper("ne", (a, b) => String(a) !== String(b));
  hbs.registerHelper("gt", (a, b) => Number(a) > Number(b));
  hbs.registerHelper("and", (...list) => args(list).every(Boolean));
  hbs.registerHelper("or", (...list) => args(list).some(Boolean));
  hbs.registerHelper("not", (v) => !v);
  hbs.registerHelper("includes", (list, value) => Array.isArray(list) && list.map(String).includes(String(value)));
  hbs.registerHelper("selected", (a, b) => (String(a) === String(b) ? "selected" : ""));
  hbs.registerHelper("checked", (a, b) => (String(a) === String(b) ? "checked" : ""));
  hbs.registerHelper("add", (a, b) => Number(a) + Number(b));
  hbs.registerHelper("plural", (n, one, many) => (Number(n) === 1 ? one : many));
  hbs.registerHelper("number", (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-PH")));
  hbs.registerHelper("fixed", (n, digits) =>
    n === null || n === undefined || Number.isNaN(Number(n)) ? "—" : Number(n).toFixed(typeof digits === "number" ? digits : 1));
  hbs.registerHelper("pct", (part, total) => {
    const t = Number(total);
    return t > 0 ? Math.round((Number(part) / t) * 100) : 0;
  });
  // Bar width (percentage of the largest value), never below 2% so a non-zero bar stays visible.
  hbs.registerHelper("barWidth", (value, max) => {
    const v = Number(value);
    const m = Number(max);
    if (!m || !v) return 0;
    return Math.max(2, Math.round((v / m) * 100));
  });

  hbs.registerHelper("formatDate", (v) => formatDate(v));
  hbs.registerHelper("formatDateTime", (v) => formatDateTime(v));
  hbs.registerHelper("timeAgo", (v) => timeAgo(v));
  hbs.registerHelper("duration", (minutes) => formatDuration(minutes));
  hbs.registerHelper("isoDate", (v) => (v ? new Date(v).toISOString() : ""));

  hbs.registerHelper("statusLabel", (s) => STATUS_LABELS[s] || s);
  hbs.registerHelper("statusHint", (s) => STATUS_HINTS[s] || "");
  hbs.registerHelper("priorityLabel", (p) => PRIORITY_LABELS[p] || p);
  hbs.registerHelper("caseTypeLabel", (c) => CASE_TYPE_LABELS[c] || c);
  hbs.registerHelper("levelLabel", (l) => ESCALATION_LEVEL_LABELS[l] ?? l);
  hbs.registerHelper("employmentLabel", (s) => EMPLOYMENT_STATUS_LABELS[s] || s);
  hbs.registerHelper("peso", (n) => (n === null || n === undefined ? "—" : "₱" + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  hbs.registerHelper("roleLabel", (r) => ROLE_LABELS[r] || r);
  hbs.registerHelper("historyFieldLabel", (f) => HISTORY_FIELD_LABELS[f] || f);
  hbs.registerHelper("historyValue", (field, value) => historyValueLabel(field, value));

  hbs.registerHelper("statusBadge", (status) =>
    safe(`<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_BADGES[status] || STATUS_BADGES.closed}">${esc(STATUS_LABELS[status] || status)}</span>`));

  hbs.registerHelper("priorityBadge", (priority) =>
    safe(`<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PRIORITY_BADGES[priority] || PRIORITY_BADGES.low}">${esc(PRIORITY_LABELS[priority] || priority)}</span>`));

  hbs.registerHelper("overdueBadge", () =>
    safe(`<span class="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white"><svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${ICONS.clock}"/></svg>Overdue</span>`));

  hbs.registerHelper("demoBadge", () =>
    safe(`<span class="inline-flex items-center whitespace-nowrap rounded border border-dashed border-sky-400 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700" title="Demo record created by the demo seeder (removed by seed:clear)">Demo</span>`));

  hbs.registerHelper("mockBadge", () =>
    safe(`<span class="inline-flex items-center whitespace-nowrap rounded border border-dashed border-amber-500 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800" title="From the mock HR fixture, not real HR data">Mock HR</span>`));

  // Status chip for outbox / inbox / compensation / reconciliation / adapter-mode values (Integration Health).
  const INTEGRATION_BADGES = {
    sent: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "Sent"], processed: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "Processed"], confirmed: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "Confirmed"],
    done: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "Done"], live: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "Live"],
    pending: ["bg-sky-50 text-sky-700 ring-sky-200", "Waiting to send"], received: ["bg-sky-50 text-sky-700 ring-sky-200", "Received"], waiting: ["bg-sky-50 text-sky-700 ring-sky-200", "Waiting"], in_progress: ["bg-sky-50 text-sky-700 ring-sky-200", "In progress"],
    failed: ["bg-amber-50 text-amber-800 ring-amber-200", "Retrying"], retrying: ["bg-amber-50 text-amber-800 ring-amber-200", "Retrying"],
    dead: ["bg-red-50 text-red-700 ring-red-200", "Dead letter"], unmatched: ["bg-red-50 text-red-700 ring-red-200", "Unmatched"], missing: ["bg-red-50 text-red-700 ring-red-200", "Missing"],
    mock: ["bg-amber-50 text-amber-800 ring-amber-300", "Mock"], mock_delivered: ["bg-amber-50 text-amber-800 ring-amber-300", "Mock (never sent)"], not_sent: ["bg-amber-50 text-amber-800 ring-amber-300", "Mock / disabled, not sent"],
    disabled: ["bg-slate-100 text-slate-600 ring-slate-200", "Disabled"], skipped_disabled: ["bg-slate-100 text-slate-600 ring-slate-200", "Skipped (disabled)"], ignored: ["bg-slate-100 text-slate-600 ring-slate-200", "Ignored"],
  };
  hbs.registerHelper("integrationBadge", (status) => {
    const [cls, label] = INTEGRATION_BADGES[status] || ["bg-slate-100 text-slate-600 ring-slate-200", String(status)];
    return safe(`<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}">${esc(label)}</span>`);
  });

  // Status chip for an employee request (Approvals Queue).
  const APPROVAL_BADGES = {
    pending: ["bg-sky-50 text-sky-700 ring-sky-200", "Pending"], approved: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "Approved"], rejected: ["bg-red-50 text-red-700 ring-red-200", "Rejected"],
    returned: ["bg-slate-100 text-slate-600 ring-slate-200", "Returned to HR"], exception: ["bg-amber-50 text-amber-800 ring-amber-300", "Needs the Manager"], superseded: ["bg-slate-100 text-slate-500 ring-slate-200", "Superseded"],
  };
  hbs.registerHelper("approvalBadge", (status) => {
    const [cls, label] = APPROVAL_BADGES[status] || ["bg-slate-100 text-slate-600 ring-slate-200", String(status)];
    return safe(`<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}">${esc(label)}</span>`);
  });

  hbs.registerHelper("icon", (name, cls) => {
    const d = ICONS[name] || ICONS.info;
    const className = typeof cls === "string" ? cls : "h-5 w-5";
    return safe(`<svg class="${esc(className)}" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`);
  });

  hbs.registerHelper("stars", (rating) => {
    const r = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    const star = (on) => `<svg class="h-4 w-4 ${on ? "text-amber-400" : "text-slate-300"}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${ICONS.star}"/></svg>`;
    return safe(`<span class="inline-flex items-center gap-0.5" role="img" aria-label="${r} out of 5 stars">${[1, 2, 3, 4, 5].map((i) => star(i <= r)).join("")}</span>`);
  });

  hbs.registerHelper("initials", (name) =>
    String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join(""));

  hbs.registerHelper("firstName", (name) => String(name || "").trim().split(/\s+/)[0] || "there");
  // {{statIcon href icon tone alert}} / {{statBg ...}} / {{statDecor ...}}: see STAT_ICONS above. The last argument is Handlebars' options object.
  hbs.registerHelper("statIcon", (href, icon, tone, alert) => statMeta(href, icon, tone, alert).icon);
  hbs.registerHelper("statBg", (href, icon, tone, alert) => statMeta(href, icon, tone, alert).bg);
  hbs.registerHelper("statDecor", (href, icon, tone, alert) => statMeta(href, icon, tone, alert).decor);
  hbs.registerHelper("ratingText", (avg, total) => (Number(total) > 0 ? `${Number(avg || 0).toFixed(1)}/5` : "—"));

  hbs.registerHelper("fileSize", (bytes) => {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  });

  hbs.registerHelper("year", () => new Date().getFullYear());
  hbs.registerHelper("array", (...list) => args(list));
  hbs.registerHelper("concat", (...list) => args(list).map((v) => (v === null || v === undefined ? "—" : v)).join(""));
};
