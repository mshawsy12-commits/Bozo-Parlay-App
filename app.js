const {
  useState,
  useEffect,
  useCallback,
  useRef
} = React;

/* ---------------------------------------------------------------
   BOZO PARLAY — operational build
   Firestore layout (see firebase-config.js for the BozoDB helper):
     meta/roster        -> { list: [{ name }] }            (seeded once)
     meta/weeksList      -> { list: [{ id, label, createdAt }] }
     meta/config          -> { oddsApiKey }
     claims/{name}        -> { uid }                        (one Firebase account per roster name)
     weeks/{id}            -> { id, label, bozo }
     weeks/{id}/picks/{name} -> Pick                          (one doc per person -> lets rules enforce ownership)
     weeks/{id}/votes/{voter}-> { nominee }
   Admin: the person named "Mike" can edit anyone's pick. Everyone else can only edit their own.
------------------------------------------------------------------ */

const ROSTER = ["Condor", "Mike", "Rhys", "Nicole", "Robsy", "Zach"];
const ADMIN_NAME = "Mike";
const DEFAULT_WEEKS = [...Array.from({
  length: 18
}, (_, i) => ({
  id: `week-${i + 1}`,
  label: `Week ${i + 1}`
})), {
  id: "wildcard",
  label: "Wild Card"
}, {
  id: "divisional",
  label: "Divisional"
}, {
  id: "conference",
  label: "Conference Champ."
}, {
  id: "superbowl",
  label: "Super Bowl"
}].map(w => ({
  ...w,
  createdAt: 0
}));
const BET_TYPES = [{
  id: "moneyline",
  label: "Moneyline"
}, {
  id: "spread",
  label: "Spread"
}, {
  id: "total",
  label: "Total (Over/Under)"
}, {
  id: "prop",
  label: "Prop / Other"
}];
const PROP_MARKETS = [{
  key: "player_pass_yds",
  label: "Passing Yards"
}, {
  key: "player_pass_tds",
  label: "Passing TDs"
}, {
  key: "player_pass_completions",
  label: "Completions"
}, {
  key: "player_rush_yds",
  label: "Rushing Yards"
}, {
  key: "player_rush_attempts",
  label: "Rush Attempts"
}, {
  key: "player_reception_yds",
  label: "Receiving Yards"
}, {
  key: "player_receptions",
  label: "Receptions"
}, {
  key: "player_anytime_td",
  label: "Anytime TD Scorer"
}];
const STATUS_META = {
  pending: {
    label: "Pending",
    cls: "st-pending"
  },
  win: {
    label: "Win",
    cls: "st-win"
  },
  loss: {
    label: "Loss",
    cls: "st-loss"
  },
  push: {
    label: "Push",
    cls: "st-push"
  }
};
function decimalToUnits(odds) {
  const n = Number(odds);
  if (!n || n <= 1) return 0;
  return n - 1;
}
function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function initials(name) {
  return (name || "").slice(0, 2).toUpperCase();
}
function oddsLabel(odds) {
  const n = Number(odds);
  if (!n) return "—";
  return n.toFixed(2);
}
function formatKickoff(bet) {
  if (!bet?.gameDate) return "TBD";
  const iso = `${bet.gameDate}T${bet.kickoffTime || "00:00"}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "TBD";
  if (bet.kickoffTime) {
    return d.toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit"
    });
  }
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}
function toLocalDateTimeParts(isoString) {
  const d = new Date(isoString);
  const pad = n => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return {
    date,
    time
  };
}
function isVotingWindowOpen(now = new Date()) {
  const day = now.getDay();
  const hour = now.getHours();
  if (day === 2 || day === 3) return true;
  if (day === 4 && hour < 12) return true;
  return false;
}
function weekLosers(picks) {
  return Object.entries(picks || {}).filter(([, bet]) => bet.status === "loss").map(([name]) => name);
}
function voteTally(votes) {
  const tally = {};
  Object.values(votes || {}).forEach(nominee => {
    tally[nominee] = (tally[nominee] || 0) + 1;
  });
  return tally;
}
function parlayPayout(picks, stake) {
  const values = Object.values(picks || {});
  if (values.length === 0) return null;
  const combinedOdds = values.reduce((acc, p) => acc * (Number(p.odds) || 1), 1);
  const payout = stake * combinedOdds;
  return {
    legs: values.length,
    combinedOdds,
    payout,
    profit: payout - stake
  };
}

/* ---------------- ESPN NFL scoreboard: search + live/final checking ---------------- */

async function fetchEspnScoreboard(dateStr) {
  const yyyymmdd = (dateStr || "").replaceAll("-", "");
  const url = yyyymmdd ? `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${yyyymmdd}` : `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch-failed");
  return res.json();
}
function eventToOption(ev) {
  const comp = ev.competitions?.[0];
  const home = comp?.competitors?.find(c => c.homeAway === "home");
  const away = comp?.competitors?.find(c => c.homeAway === "away");
  return {
    id: ev.id,
    isoDate: ev.date,
    home: home?.team?.displayName || "Home",
    away: away?.team?.displayName || "Away"
  };
}
function findEventById(data, id) {
  const ev = (data?.events || []).find(e => e.id === id);
  if (!ev) return null;
  return {
    ev,
    comp: ev.competitions?.[0]
  };
}
function findEventByTeam(data, teamName, oppName) {
  const events = data?.events || [];
  const wanted = normalize(teamName);
  const wantedOpp = normalize(oppName);
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const names = comp.competitors.map(c => normalize(c.team?.displayName + " " + c.team?.shortDisplayName + " " + c.team?.abbreviation));
    const hasTeam = names.some(n => wanted && n.includes(wanted));
    const hasOpp = !wantedOpp || names.some(n => n.includes(wantedOpp));
    if (hasTeam && hasOpp) return {
      ev,
      comp
    };
  }
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const names = comp.competitors.map(c => normalize(c.team?.displayName + " " + c.team?.shortDisplayName + " " + c.team?.abbreviation));
    if (names.some(n => wanted && n.includes(wanted))) return {
      ev,
      comp
    };
  }
  return null;
}
function readSides(pick, comp) {
  const wanted = normalize(pick.team);
  const mine = comp.competitors.find(c => normalize(c.team?.displayName + " " + c.team?.shortDisplayName + " " + c.team?.abbreviation).includes(wanted));
  const other = comp.competitors.find(c => c !== mine);
  return {
    mine,
    other
  };
}
function gradePick(pick, comp) {
  const {
    mine,
    other
  } = readSides(pick, comp);
  if (!mine || !other) return {
    status: "pending",
    finalScore: null,
    reason: "no-match"
  };
  const myScore = Number(mine.score);
  const oppScore = Number(other.score);
  const finalScore = `${mine.team.abbreviation} ${myScore} — ${other.team.abbreviation} ${oppScore}`;
  if (pick.betType === "moneyline") {
    if (myScore === oppScore) return {
      status: "push",
      finalScore
    };
    return {
      status: myScore > oppScore ? "win" : "loss",
      finalScore
    };
  }
  if (pick.betType === "spread") {
    const line = Number(pick.line || 0);
    const adjusted = myScore + line;
    if (adjusted === oppScore) return {
      status: "push",
      finalScore
    };
    return {
      status: adjusted > oppScore ? "win" : "loss",
      finalScore
    };
  }
  if (pick.betType === "total") {
    const line = Number(pick.line || 0);
    const sum = myScore + oppScore;
    const finalScoreT = `${mine.team.abbreviation} ${myScore} — ${other.team.abbreviation} ${oppScore} (Total ${sum})`;
    if (sum === line) return {
      status: "push",
      finalScore: finalScoreT
    };
    const over = sum > line;
    const won = pick.side === "over" ? over : !over;
    return {
      status: won ? "win" : "loss",
      finalScore: finalScoreT
    };
  }
  return {
    status: "pending",
    finalScore: null,
    reason: "unsupported-bet-type"
  };
}
function liveInfo(pick, comp) {
  const {
    mine,
    other
  } = readSides(pick, comp);
  if (!mine || !other) return null;
  return {
    clock: comp.status?.displayClock || "",
    period: comp.status?.period || null,
    myAbbr: mine.team.abbreviation,
    oppAbbr: other.team.abbreviation,
    myScore: mine.score,
    oppScore: other.score
  };
}
async function fetchOddsApiScores(apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores/?apiKey=${encodeURIComponent(apiKey)}&daysFrom=3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch-failed");
  return res.json();
}
function findOddsApiEvent(events, teamName, oppName) {
  const wanted = normalize(teamName);
  const wantedOpp = normalize(oppName);
  const nameSet = ev => [normalize(ev.home_team), normalize(ev.away_team)];
  let match = events.find(ev => {
    const [h, a] = nameSet(ev);
    const hasTeam = (h.includes(wanted) || a.includes(wanted)) && wanted;
    const hasOpp = !wantedOpp || h.includes(wantedOpp) || a.includes(wantedOpp);
    return hasTeam && hasOpp;
  });
  if (!match) match = events.find(ev => {
    const [h, a] = nameSet(ev);
    return wanted && (h.includes(wanted) || a.includes(wanted));
  });
  if (!match) return null;
  const comp = {
    status: {
      type: {
        completed: !!match.completed,
        state: match.completed ? "post" : "pre"
      }
    },
    competitors: (match.scores || []).map(s => ({
      team: {
        displayName: s.name,
        shortDisplayName: s.name,
        abbreviation: s.name
      },
      score: s.score
    }))
  };
  return {
    ev: match,
    comp
  };
}
async function fetchOddsApiOdds(apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=us,uk&markets=h2h,spreads,totals&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch-failed");
  return res.json();
}
function findOddsApiOddsEvent(events, teamName, oppName) {
  const wanted = normalize(teamName);
  const wantedOpp = normalize(oppName);
  const nameSet = ev => [normalize(ev.home_team), normalize(ev.away_team)];
  let match = events.find(ev => {
    const [h, a] = nameSet(ev);
    const hasTeam = (h.includes(wanted) || a.includes(wanted)) && wanted;
    const hasOpp = !wantedOpp || h.includes(wantedOpp) || a.includes(wantedOpp);
    return hasTeam && hasOpp;
  });
  if (!match) match = events.find(ev => {
    const [h, a] = nameSet(ev);
    return wanted && (h.includes(wanted) || a.includes(wanted));
  });
  return match || null;
}
// Flattens one matched event's bookmakers into simple rows for the bet type currently selected.
function oddsRowsForMarket(event, betType, teamName, side) {
  if (!event) return [];
  const marketKey = betType === "moneyline" ? "h2h" : betType === "spread" ? "spreads" : betType === "total" ? "totals" : null;
  if (!marketKey) return [];
  const wanted = normalize(teamName);
  const rows = [];
  for (const bk of event.bookmakers || []) {
    const market = bk.markets?.find(m => m.key === marketKey);
    if (!market) continue;
    if (marketKey === "totals") {
      const outcome = market.outcomes?.find(o => o.name?.toLowerCase() === side);
      if (outcome) rows.push({
        bookmaker: bk.title,
        odds: outcome.price,
        line: outcome.point
      });
    } else {
      const outcome = market.outcomes?.find(o => normalize(o.name).includes(wanted));
      if (outcome) rows.push({
        bookmaker: bk.title,
        odds: outcome.price,
        line: outcome.point
      });
    }
  }
  return rows;
}

// ---- player props: needs the Odds API's own event id (already present on the
// matched event object from fetchOddsApiOdds), then a per-event props call ----
async function fetchPlayerProps(apiKey, eventId, marketKey) {
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/${eventId}/odds?apiKey=${encodeURIComponent(apiKey)}&regions=us&markets=${marketKey}&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch-failed");
  return res.json();
}
// Flattens one event's bookmakers into simple prop rows for a given market.
function propRowsForMarket(eventOdds, marketKey) {
  if (!eventOdds) return [];
  const rows = [];
  for (const bk of eventOdds.bookmakers || []) {
    const market = bk.markets?.find(m => m.key === marketKey);
    if (!market) continue;
    for (const o of market.outcomes || []) {
      if (o.description) {
        // standard over/under prop: name = "Over"/"Under", description = player name, point = line
        rows.push({
          bookmaker: bk.title,
          player: o.description,
          side: o.name,
          line: o.point,
          odds: o.price
        });
      } else {
        // anytime-TD style: name = player name, no line
        rows.push({
          bookmaker: bk.title,
          player: o.name,
          side: null,
          line: null,
          odds: o.price
        });
      }
    }
  }
  return rows;
}

/* ---------------- UI helpers ---------------- */

function Badge({
  status,
  bet
}) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  const label = status === "pending" ? formatKickoff(bet) : meta.label;
  return /*#__PURE__*/React.createElement("span", {
    className: `badge ${meta.cls}`
  }, label);
}
function Avatar({
  name
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: "bp-avatar"
  }, initials(name));
}
function JesterHat({
  size = 40
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 120 120",
    style: {
      display: "block"
    },
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M 44 88 C 14 84 -2 62 8 42 C 14 30 26 24 34 32 C 40 38 38 48 30 54 C 34 60 40 64 40 74 C 40 80 42 85 44 88 Z",
    fill: "#ED3455"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "46",
    r: "8",
    fill: "#F2803F"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M 58 86 C 52 54 62 20 90 6 C 102 0 114 4 116 10 C 108 12 96 20 88 34 C 96 40 100 50 94 60 C 88 70 74 78 66 86 Z",
    fill: "#3B93D8"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "114",
    cy: "9",
    r: "8",
    fill: "#F2803F"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M 76 88 C 106 84 122 62 112 42 C 106 30 94 24 86 32 C 80 38 82 48 90 54 C 86 60 80 64 80 74 C 80 80 78 85 76 88 Z",
    fill: "#5CA633"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "108",
    cy: "46",
    r: "8",
    fill: "#F2803F"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "18",
    y: "84",
    width: "84",
    height: "22",
    rx: "9",
    fill: "#FFC107"
  }));
}
function BozoFlair({
  inline
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: inline ? "bp-bozo-inline" : "bp-bozo-flair"
  }, /*#__PURE__*/React.createElement(JesterHat, {
    size: inline ? 20 : 40
  }));
}

/* ---------------- Auth screen ---------------- */

function AuthScreen({
  claims
}) {
  const [mode, setMode] = useState("login"); // 'login' | 'signup'
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const claimedNames = Object.keys(claims || {});
  const unclaimedNames = ROSTER.filter(n => !claimedNames.includes(n));
  async function submit() {
    setError("");
    if (!name) {
      setError("Pick your name.");
      return;
    }
    if (!password || password.length < 6) {
      setError("Password needs to be at least 6 characters.");
      return;
    }
    if (mode === "signup" && password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        await window.BozoDB.signUp(name, password);
      } else {
        await window.BozoDB.logIn(name, password);
      }
    } catch (e) {
      setError(e.code === "auth/wrong-password" || e.code === "auth/invalid-credential" ? "Wrong password." : e.code === "auth/email-already-in-use" ? "That name already has an account — log in instead." : e.code === "auth/user-not-found" ? "No account for that name yet — sign up instead." : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "bp-root",
    style: {
      padding: "36px 24px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-auth"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-title-left",
    style: {
      justifyContent: "center",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-logo"
  }, /*#__PURE__*/React.createElement(JesterHat, {
    size: 22
  })), /*#__PURE__*/React.createElement("h1", {
    className: "bp-title"
  }, "Bozo ", /*#__PURE__*/React.createElement("span", null, "Parlay"))), /*#__PURE__*/React.createElement("div", {
    className: "bp-tabs",
    style: {
      margin: "18px auto"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: `bp-tab ${mode === "login" ? "active" : ""}`,
    onClick: () => setMode("login")
  }, "Log In"), /*#__PURE__*/React.createElement("button", {
    className: `bp-tab ${mode === "signup" ? "active" : ""}`,
    onClick: () => setMode("signup")
  }, "Sign Up")), /*#__PURE__*/React.createElement("label", null, "Your name"), /*#__PURE__*/React.createElement("select", {
    value: name,
    onChange: e => setName(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), (mode === "signup" ? unclaimedNames : ROSTER).map(n => /*#__PURE__*/React.createElement("option", {
    key: n,
    value: n
  }, n))), mode === "signup" && unclaimedNames.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Everyone's already signed up — switch to Log In."), /*#__PURE__*/React.createElement("label", null, "Password"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    value: password,
    onChange: e => setPassword(e.target.value),
    placeholder: "At least 6 characters"
  }), mode === "signup" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("label", null, "Confirm password"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    value: confirm,
    onChange: e => setConfirm(e.target.value)
  })), error && /*#__PURE__*/React.createElement("div", {
    className: "bp-error"
  }, error), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn",
    onClick: submit,
    disabled: busy,
    style: {
      marginTop: 10
    }
  }, busy ? "…" : mode === "signup" ? "Create account" : "Log in"), /*#__PURE__*/React.createElement("div", {
    className: "bp-hint",
    style: {
      marginTop: 14
    }
  }, "Each person on the roster gets one account. ", ADMIN_NAME, " can edit anyone's pick if something needs fixing; everyone else can only edit their own.")));
}

/* ---------------- App ---------------- */

function App() {
  const [dbReady, setDbReady] = useState(!!window.BozoDB);
  const [authUser, setAuthUser] = useState(undefined); // undefined = loading, null = signed out
  const [claims, setClaims] = useState({});
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState([]);
  const [weeksList, setWeeksList] = useState([]);
  const [currentWeekId, setCurrentWeekId] = useState(null);
  const [weekMeta, setWeekMeta] = useState(null);
  const [weekPicks, setWeekPicks] = useState({});
  const [weekVotes, setWeekVotes] = useState({});
  const [tab, setTab] = useState("bets");
  const [editingPerson, setEditingPerson] = useState(null);
  const [grading, setGrading] = useState({});
  const [oddsApiKey, setOddsApiKey] = useState("");
  const [voteModalOpen, setVoteModalOpen] = useState(false);
  const [dismissedVoteWeek, setDismissedVoteWeek] = useState(null);
  const [creatingBetslip, setCreatingBetslip] = useState(false);
  const [seasonCache, setSeasonCache] = useState({}); // weekId -> { meta, picks }
  const [seasonLoading, setSeasonLoading] = useState(false);
  const intervalRef = useRef(null);
  useEffect(() => {
    if (dbReady) return;
    const onReady = () => setDbReady(true);
    window.addEventListener("bozo-db-ready", onReady);
    return () => window.removeEventListener("bozo-db-ready", onReady);
  }, [dbReady]);

  // auth state
  useEffect(() => {
    if (!dbReady) return;
    return window.BozoDB.onAuthChange(u => setAuthUser(u || null));
  }, [dbReady]);

  // claims (name -> uid) live
  useEffect(() => {
    if (!dbReady) return;
    return window.BozoDB.watchClaims(setClaims);
  }, [dbReady]);
  const loggedInName = authUser ? Object.keys(claims).find(n => claims[n] === authUser.uid) || null : null;
  const isAdmin = loggedInName === ADMIN_NAME;
  const canEdit = name => loggedInName === name || isAdmin;
  const canEditStake = isAdmin || weekMeta?.bozo && loggedInName === weekMeta.bozo;

  // seed roster + weeks, load config (once signed in)
  useEffect(() => {
    if (!dbReady || !authUser) return;
    (async () => {
      let roster = await window.BozoDB.getMeta("roster");
      if (!roster || !roster.list?.length) {
        roster = {
          list: ROSTER.map(name => ({
            name
          }))
        };
        await window.BozoDB.setMeta("roster", roster);
      }
      setPeople(roster.list);
      let wl = await window.BozoDB.getMeta("weeksList");
      if (!wl || !wl.list?.length) {
        wl = {
          list: DEFAULT_WEEKS
        };
        await window.BozoDB.setMeta("weeksList", wl);
        for (const w of DEFAULT_WEEKS) {
          await window.BozoDB.setWeekMeta(w.id, {
            id: w.id,
            label: w.label,
            bozo: null,
            stake: 20
          });
        }
      }
      setWeeksList(wl.list);
      setCurrentWeekId(wl.list[0].id);
      const cfg = await window.BozoDB.getMeta("config");
      setOddsApiKey(cfg?.oddsApiKey || "");
      setLoading(false);
    })();
  }, [dbReady, authUser]);

  // live weeksList
  useEffect(() => {
    if (!dbReady || !authUser) return;
    return window.BozoDB.watchMeta("weeksList", data => {
      if (data?.list?.length) setWeeksList(data.list);
    });
  }, [dbReady, authUser]);

  // live current week meta + picks + votes
  useEffect(() => {
    if (!dbReady || !authUser || !currentWeekId) return;
    const unsubs = [window.BozoDB.watchWeekMeta(currentWeekId, data => setWeekMeta(data || {
      id: currentWeekId,
      label: currentWeekId,
      bozo: null
    })), window.BozoDB.watchPicks(currentWeekId, setWeekPicks), window.BozoDB.watchVotes(currentWeekId, setWeekVotes)];
    return () => unsubs.forEach(u => u && u());
  }, [dbReady, authUser, currentWeekId]);

  // auto-open vote modal Tue–Thu-noon
  useEffect(() => {
    if (!weekMeta) return;
    if (isVotingWindowOpen() && !weekMeta.bozo && weekLosers(weekPicks).length > 0 && dismissedVoteWeek !== currentWeekId) {
      setVoteModalOpen(true);
    }
  }, [weekMeta, weekPicks, currentWeekId, dismissedVoteWeek]);
  async function updateOddsApiKey() {
    const next = window.prompt("Paste your free The Odds API key (from the-odds-api.com). Leave blank to clear it.", oddsApiKey);
    if (next === null) return;
    setOddsApiKey(next);
    await window.BozoDB.setMeta("config", {
      oddsApiKey: next
    });
  }
  async function createBetslip() {
    const label = window.prompt("Name this betslip (e.g. 'Thanksgiving Special', 'Survivor Round 2'):");
    if (!label || !label.trim()) return;
    setCreatingBetslip(true);
    const id = `betslip-${Date.now()}`;
    const entry = {
      id,
      label: label.trim(),
      createdAt: Date.now()
    };
    const nextList = [...weeksList, entry];
    setWeeksList(nextList);
    await window.BozoDB.setMeta("weeksList", {
      list: nextList
    });
    await window.BozoDB.setWeekMeta(id, {
      id,
      label: label.trim(),
      bozo: null,
      stake: 20
    });
    setCreatingBetslip(false);
    setTab("bets");
    setCurrentWeekId(id);
  }
  async function saveWeeklyPick(person, pick) {
    if (!canEdit(person)) return;
    await window.BozoDB.setPick(currentWeekId, person, {
      ...pick,
      updatedAt: Date.now()
    });
    setEditingPerson(null);
  }
  async function setManualStatus(person, status) {
    const bet = weekPicks[person];
    if (!bet) return;
    await window.BozoDB.setPick(currentWeekId, person, {
      ...bet,
      status
    });
  }
  async function clearPick(person) {
    if (!canEdit(person)) return;
    if (!window.confirm(`Clear ${person}'s pick for this week? This can't be undone.`)) return;
    await window.BozoDB.deletePick(currentWeekId, person);
  }
  async function setBozo(person) {
    await window.BozoDB.setWeekMeta(currentWeekId, {
      ...weekMeta,
      bozo: person || null
    });
  }
  async function editStake() {
    if (!canEditStake) return;
    const current = weekMeta.stake ?? 20;
    const next = window.prompt("Weekly stake amount ($):", current);
    if (next === null) return;
    const parsed = Number(next);
    if (isNaN(parsed) || parsed < 0) {
      window.alert("Enter a valid non-negative number.");
      return;
    }
    await window.BozoDB.setWeekMeta(currentWeekId, {
      ...weekMeta,
      stake: parsed
    });
  }
  async function castVote(nominee) {
    if (!loggedInName) return;
    await window.BozoDB.setVote(currentWeekId, loggedInName, nominee);
  }
  async function finalizeBozoVote() {
    const tally = voteTally(weekVotes);
    const entries = Object.entries(tally);
    if (entries.length === 0) return;
    const max = Math.max(...entries.map(([, c]) => c));
    const winners = entries.filter(([, c]) => c === max).map(([n]) => n);
    if (winners.length === 1) {
      await setBozo(winners[0]);
      setVoteModalOpen(false);
    } else {
      window.alert(`It's a tie between ${winners.join(" and ")} — keep voting or set it manually.`);
    }
  }
  function dismissVoteModal() {
    setDismissedVoteWeek(currentWeekId);
    setVoteModalOpen(false);
  }
  async function checkScore(person) {
    const bet = weekPicks[person];
    if (!bet || !bet.gameDate || bet.betType === "prop") return;
    setGrading(g => ({
      ...g,
      [person]: "checking"
    }));
    if (oddsApiKey) {
      try {
        const events = await fetchOddsApiScores(oddsApiKey);
        const found = findOddsApiEvent(events, bet.team, bet.opponent);
        if (found && found.comp.status.type.completed) {
          const result = gradePick(bet, found.comp);
          if (result.status !== "pending") {
            await window.BozoDB.setPick(currentWeekId, person, {
              ...bet,
              status: result.status,
              finalScore: result.finalScore,
              live: null
            });
            setGrading(g => ({
              ...g,
              [person]: "done"
            }));
            return;
          }
        }
      } catch {
        // fall through to ESPN
      }
    }
    try {
      const data = await fetchEspnScoreboard(bet.gameDate);
      const found = bet.espnEventId ? findEventById(data, bet.espnEventId) : findEventByTeam(data, bet.team, bet.opponent);
      if (!found || !found.comp) {
        setGrading(g => ({
          ...g,
          [person]: "not-found"
        }));
        return;
      }
      const state = found.comp.status?.type?.state;
      if (state === "post") {
        const result = gradePick(bet, found.comp);
        await window.BozoDB.setPick(currentWeekId, person, {
          ...bet,
          status: result.status,
          finalScore: result.finalScore,
          live: null
        });
        setGrading(g => ({
          ...g,
          [person]: "done"
        }));
      } else if (state === "in") {
        const info = liveInfo(bet, found.comp);
        await window.BozoDB.setPick(currentWeekId, person, {
          ...bet,
          live: info
        });
        setGrading(g => ({
          ...g,
          [person]: "live"
        }));
      } else {
        setGrading(g => ({
          ...g,
          [person]: "not-final"
        }));
      }
    } catch {
      setGrading(g => ({
        ...g,
        [person]: "error"
      }));
    }
  }
  useEffect(() => {
    if (!authUser) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      Object.entries(weekPicks).forEach(([person, bet]) => {
        if (bet.status === "pending" && bet.betType !== "prop") checkScore(person);
      });
    }, 25000);
    return () => intervalRef.current && clearInterval(intervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, currentWeekId, weekPicks]);
  const loadSeason = useCallback(async () => {
    setSeasonLoading(true);
    const cache = {
      ...seasonCache
    };
    for (const w of weeksList) {
      if (!cache[w.id]) {
        const meta = (await window.BozoDB.getWeekMeta(w.id)) || {
          label: w.label,
          bozo: null
        };
        const picks = await window.BozoDB.getPicksOnce(w.id);
        cache[w.id] = {
          meta,
          picks
        };
      }
    }
    setSeasonCache(cache);
    setSeasonLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeksList]);
  useEffect(() => {
    if (dbReady && authUser && tab === "standings" && weeksList.length) loadSeason();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbReady, authUser, tab, weeksList.length]);
  function computeStandings() {
    const totals = {};
    for (const p of people) totals[p.name] = {
      win: 0,
      loss: 0,
      push: 0,
      pending: 0,
      units: 0,
      bozos: 0
    };
    for (const w of weeksList) {
      const entry = seasonCache[w.id];
      if (!entry) continue;
      for (const [person, bet] of Object.entries(entry.picks || {})) {
        if (!totals[person]) totals[person] = {
          win: 0,
          loss: 0,
          push: 0,
          pending: 0,
          units: 0,
          bozos: 0
        };
        totals[person][bet.status] = (totals[person][bet.status] || 0) + 1;
        if (bet.status === "win") totals[person].units += decimalToUnits(bet.odds);
        if (bet.status === "loss") totals[person].units -= 1;
      }
      if (entry.meta?.bozo && totals[entry.meta.bozo]) totals[entry.meta.bozo].bozos += 1;
    }
    return totals;
  }
  if (!dbReady || authUser === undefined) {
    return /*#__PURE__*/React.createElement("div", {
      className: "bp-loading"
    }, "Loading…");
  }
  if (!authUser) {
    return /*#__PURE__*/React.createElement(AuthScreen, {
      claims: claims
    });
  }
  if (loading || !weekMeta) {
    return /*#__PURE__*/React.createElement("div", {
      className: "bp-loading"
    }, "Loading…");
  }
  const totals = computeStandings();
  return /*#__PURE__*/React.createElement("div", {
    className: "bp-root"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-scoreboard"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-title-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-title-left"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-logo"
  }, /*#__PURE__*/React.createElement(JesterHat, {
    size: 22
  })), /*#__PURE__*/React.createElement("h1", {
    className: "bp-title"
  }, "Bozo ", /*#__PURE__*/React.createElement("span", null, "Parlay"))), /*#__PURE__*/React.createElement("div", {
    className: "bp-week-select"
  }, tab === "bets" && /*#__PURE__*/React.createElement("select", {
    className: "bp-select",
    value: currentWeekId,
    onChange: e => setCurrentWeekId(e.target.value)
  }, weeksList.map(w => /*#__PURE__*/React.createElement("option", {
    key: w.id,
    value: w.id
  }, w.label))), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn",
    onClick: createBetslip,
    disabled: creatingBetslip
  }, "+ New Betslip"), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost",
    onClick: updateOddsApiKey
  }, oddsApiKey ? "🔑 Odds API set" : "🔑 Add Odds API key"), /*#__PURE__*/React.createElement("span", {
    className: "bp-whoami"
  }, loggedInName, " ", isAdmin && /*#__PURE__*/React.createElement("span", {
    className: "bp-admin-tag"
  }, "admin"), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small",
    onClick: () => window.BozoDB.logOut()
  }, "Log out")))), /*#__PURE__*/React.createElement("div", {
    className: "bp-tabs"
  }, /*#__PURE__*/React.createElement("button", {
    className: `bp-tab ${tab === "bets" ? "active" : ""}`,
    onClick: () => setTab("bets")
  }, "This Week"), /*#__PURE__*/React.createElement("button", {
    className: `bp-tab ${tab === "standings" ? "active" : ""}`,
    onClick: () => setTab("standings")
  }, "Standings"))), /*#__PURE__*/React.createElement("div", {
    className: "bp-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-content"
  }, tab === "bets" && /*#__PURE__*/React.createElement(BetsTab, {
    people: people,
    weekMeta: weekMeta,
    weekPicks: weekPicks,
    weekLabel: weekMeta.label,
    editingPerson: editingPerson,
    setEditingPerson: setEditingPerson,
    saveWeeklyPick: saveWeeklyPick,
    setManualStatus: setManualStatus,
    clearPick: clearPick,
    checkScore: checkScore,
    grading: grading,
    setBozo: setBozo,
    canEdit: canEdit,
    isAdmin: isAdmin,
    canEditStake: canEditStake,
    editStake: editStake,
    oddsApiKey: oddsApiKey,
    onOpenVote: () => setVoteModalOpen(true)
  }), tab === "standings" && /*#__PURE__*/React.createElement(StandingsTab, {
    people: people,
    weeksList: weeksList,
    seasonCache: seasonCache,
    totals: totals,
    loading: seasonLoading
  }))), voteModalOpen && /*#__PURE__*/React.createElement(BozoVoteModal, {
    weekPicks: weekPicks,
    weekVotes: weekVotes,
    weekLabel: weekMeta.label,
    loggedInName: loggedInName,
    castVote: castVote,
    onFinalize: finalizeBozoVote,
    onDismiss: dismissVoteModal
  }));
}
function BozoVoteModal({
  weekPicks,
  weekVotes,
  weekLabel,
  loggedInName,
  castVote,
  onFinalize,
  onDismiss
}) {
  const losers = weekLosers(weekPicks);
  const tally = voteTally(weekVotes);
  const votedCount = Object.keys(weekVotes || {}).length;
  const myVote = loggedInName ? weekVotes[loggedInName] : null;
  const maxVotes = Math.max(0, ...Object.values(tally));
  return /*#__PURE__*/React.createElement("div", {
    className: "bp-modal-backdrop",
    onClick: onDismiss
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-modal-panel",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-modal-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-modal-title"
  }, /*#__PURE__*/React.createElement(JesterHat, {
    size: 26
  }), " Bozo Vote — ", weekLabel), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small",
    onClick: onDismiss
  }, "✕")), losers.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "bp-hint",
    style: {
      marginTop: 8
    }
  }, "No losing picks this week — nothing to vote on.") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "bp-modal-sub"
  }, "Voting as ", /*#__PURE__*/React.createElement("b", null, loggedInName), ". These bets lost this week — vote for who should wear the hat."), /*#__PURE__*/React.createElement("div", {
    className: "bp-vote-list"
  }, losers.map(name => {
    const bet = weekPicks[name];
    const count = tally[name] || 0;
    const isLeading = count > 0 && count === maxVotes;
    const isMyVote = myVote === name;
    return /*#__PURE__*/React.createElement("button", {
      key: name,
      className: `bp-vote-item ${isMyVote ? "chosen" : ""}`,
      onClick: () => castVote(name)
    }, /*#__PURE__*/React.createElement("div", {
      className: "bp-name-row"
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: name
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "bp-name"
    }, name), /*#__PURE__*/React.createElement("div", {
      className: "bp-vote-item-desc"
    }, bet.notes || `${bet.team} vs ${bet.opponent}`))), /*#__PURE__*/React.createElement("span", {
      className: `bp-vote-count ${isLeading ? "leading" : ""}`
    }, count, " vote", count === 1 ? "" : "s"));
  })), /*#__PURE__*/React.createElement("div", {
    className: "bp-modal-footer"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-hint",
    style: {
      margin: 0
    }
  }, votedCount, "/6 voted"), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn",
    onClick: onFinalize
  }, "Crown Bozo")))));
}
function ParlayBanner({
  weekPicks,
  stake,
  canEditStake,
  editStake
}) {
  const result = parlayPayout(weekPicks, stake);
  return /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-banner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-label"
  }, "This week's parlay ", /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-sub"
  }, "(", result ? result.legs : 0, " leg", result?.legs === 1 ? "" : "s", " · all must hit)")), /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-figures"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-label"
  }, "Stake"), /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-value"
  }, "$", stake.toFixed(2), canEditStake && /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small",
    onClick: editStake,
    style: {
      marginLeft: 8
    }
  }, "Edit"))), /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-label"
  }, "Combined odds"), /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-value"
  }, result ? `${result.combinedOdds.toFixed(2)}x` : "—")), /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-stat highlight"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-label"
  }, "Potential payout"), /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-value"
  }, result ? `$${result.payout.toFixed(2)}` : "—")), /*#__PURE__*/React.createElement("div", {
    className: "bp-parlay-stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-label"
  }, "Profit if it hits"), /*#__PURE__*/React.createElement("span", {
    className: "bp-parlay-stat-value profit"
  }, result ? `+$${result.profit.toFixed(2)}` : "—")))), !result && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Add picks below to see this week's potential parlay payout."));
}
function BetsTab({
  people,
  weekMeta,
  weekPicks,
  weekLabel,
  editingPerson,
  setEditingPerson,
  saveWeeklyPick,
  setManualStatus,
  clearPick,
  checkScore,
  grading,
  setBozo,
  canEdit,
  isAdmin,
  canEditStake,
  editStake,
  oddsApiKey,
  onOpenVote
}) {
  const losers = weekLosers(weekPicks);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(ParlayBanner, {
    weekPicks: weekPicks,
    stake: weekMeta.stake ?? 20,
    canEditStake: canEditStake,
    editStake: editStake
  }), /*#__PURE__*/React.createElement("div", {
    className: "bp-week-header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-section-title"
  }, weekLabel), /*#__PURE__*/React.createElement("div", {
    className: "bp-week-tools"
  }, /*#__PURE__*/React.createElement("button", {
    className: `bp-btn small ${isVotingWindowOpen() && !weekMeta.bozo ? "" : "ghost"}`,
    onClick: onOpenVote
  }, "🗳️ Bozo Vote", losers.length > 0 ? ` (${losers.length})` : ""), /*#__PURE__*/React.createElement("span", {
    className: "bp-bozo-label"
  }, "🤡 Bozo:", /*#__PURE__*/React.createElement("select", {
    className: "bp-select",
    value: weekMeta.bozo || "",
    onChange: e => setBozo(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "— none —"), people.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.name,
    value: p.name
  }, p.name)))))), /*#__PURE__*/React.createElement("div", {
    className: "bp-grid"
  }, people.map(p => {
    const pick = weekPicks?.[p.name];
    const isEditing = editingPerson === p.name;
    const isBozo = weekMeta.bozo === p.name;
    const editable = canEdit(p.name);
    if (isEditing) {
      return /*#__PURE__*/React.createElement("div", {
        className: "bp-card",
        key: p.name,
        onDoubleClick: () => setEditingPerson(null)
      }, /*#__PURE__*/React.createElement("div", {
        className: "bp-card-head"
      }, /*#__PURE__*/React.createElement("div", {
        className: "bp-name-row"
      }, /*#__PURE__*/React.createElement(Avatar, {
        name: p.name
      }), /*#__PURE__*/React.createElement("span", {
        className: "bp-name"
      }, p.name)), /*#__PURE__*/React.createElement("button", {
        className: "bp-btn ghost small",
        onClick: () => setEditingPerson(null)
      }, "Cancel")), /*#__PURE__*/React.createElement("div", {
        onDoubleClick: e => e.stopPropagation()
      }, /*#__PURE__*/React.createElement(PickForm, {
        initial: pick,
        onSubmit: pk => saveWeeklyPick(p.name, pk),
        oddsApiKey: oddsApiKey
      })));
    }
    if (!pick) {
      return /*#__PURE__*/React.createElement("div", {
        className: "bp-empty-card",
        key: p.name,
        onDoubleClick: () => editable && setEditingPerson(p.name),
        style: !editable ? {
          cursor: "default"
        } : undefined
      }, isBozo && /*#__PURE__*/React.createElement(BozoFlair, null), /*#__PURE__*/React.createElement("div", {
        className: "bp-name-row"
      }, /*#__PURE__*/React.createElement(Avatar, {
        name: p.name
      }), /*#__PURE__*/React.createElement("span", {
        className: "bp-name"
      }, p.name)), /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--ink-dim)",
          fontSize: 13
        }
      }, editable ? "No pick yet" : "Waiting on their pick"), editable && /*#__PURE__*/React.createElement("button", {
        className: "bp-btn small",
        onClick: () => setEditingPerson(p.name)
      }, "Add Pick"));
    }
    return /*#__PURE__*/React.createElement(BetCard, {
      key: p.name,
      title: p.name,
      bet: pick,
      isBozo: isBozo,
      editable: editable,
      gradingKey: p.name,
      grading: grading,
      onEdit: () => editable && setEditingPerson(p.name),
      onCheckScore: () => checkScore(p.name),
      onManualStatus: s => setManualStatus(p.name, s),
      onClear: () => clearPick(p.name)
    });
  })));
}
function BetCard({
  title,
  bet,
  isBozo,
  editable,
  gradingKey,
  grading,
  onEdit,
  onCheckScore,
  onManualStatus,
  onClear
}) {
  const canGrade = bet.status === "pending" && bet.betType !== "prop";
  const g = grading[gradingKey];
  return /*#__PURE__*/React.createElement("div", {
    className: `bp-card ${!editable ? "readonly" : ""}`,
    onDoubleClick: editable ? onEdit : undefined
  }, isBozo && /*#__PURE__*/React.createElement(BozoFlair, null), /*#__PURE__*/React.createElement("div", {
    className: "bp-card-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-name-row"
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: title
  }), /*#__PURE__*/React.createElement("span", {
    className: "bp-name"
  }, title)), /*#__PURE__*/React.createElement(Badge, {
    status: bet.status,
    bet: bet
  })), /*#__PURE__*/React.createElement("div", {
    className: "bp-desc"
  }, bet.notes || `${bet.team} vs ${bet.opponent}`), /*#__PURE__*/React.createElement("div", {
    className: "bp-meta"
  }, /*#__PURE__*/React.createElement("span", null, BET_TYPES.find(b => b.id === bet.betType)?.label), /*#__PURE__*/React.createElement("span", {
    className: "bp-odds"
  }, oddsLabel(bet.odds))), bet.live && bet.status === "pending" && /*#__PURE__*/React.createElement("div", {
    className: "bp-live"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-live-dot"
  }), "LIVE Q", bet.live.period, " ", bet.live.clock, " · ", bet.live.myAbbr, " ", bet.live.myScore, " — ", bet.live.oppAbbr, " ", bet.live.oppScore), bet.finalScore && /*#__PURE__*/React.createElement("div", {
    className: "bp-final"
  }, "Final: ", bet.finalScore), /*#__PURE__*/React.createElement("div", {
    className: "bp-actions",
    onDoubleClick: e => e.stopPropagation()
  }, canGrade && /*#__PURE__*/React.createElement("button", {
    className: "bp-btn small",
    onClick: onCheckScore,
    disabled: g === "checking"
  }, g === "checking" ? "Checking…" : "Check Score"), editable && /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small danger",
    onClick: onClear
  }, "Clear"), !editable && /*#__PURE__*/React.createElement("span", {
    className: "bp-readonly-tag"
  }, "view only")), g === "not-final" && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Game hasn't started yet — check back later."), g === "not-found" && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Couldn't find/verify this game automatically — grade it yourself:", /*#__PURE__*/React.createElement("div", {
    className: "bp-actions",
    onDoubleClick: e => e.stopPropagation(),
    style: {
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small",
    onClick: () => onManualStatus("win")
  }, "Win"), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small",
    onClick: () => onManualStatus("loss")
  }, "Loss"), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small",
    onClick: () => onManualStatus("push")
  }, "Push"))), g === "error" && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Score check failed — try again or grade manually above."), bet.status !== "pending" && /*#__PURE__*/React.createElement("div", {
    className: "bp-actions",
    onDoubleClick: e => e.stopPropagation(),
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "bp-btn ghost small",
    onClick: () => onManualStatus("pending")
  }, "Reopen")));
}
function PickForm({
  initial,
  onSubmit,
  oddsApiKey
}) {
  const [betType, setBetType] = useState(initial?.betType || "moneyline");
  const [team, setTeam] = useState(initial?.team || "");
  const [opponent, setOpponent] = useState(initial?.opponent || "");
  const [line, setLine] = useState(initial?.line ?? "");
  const [side, setSide] = useState(initial?.side || "over");
  const [odds, setOdds] = useState(initial?.odds ?? "");
  const [gameDate, setGameDate] = useState(initial?.gameDate || "");
  const [kickoffTime, setKickoffTime] = useState(initial?.kickoffTime || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [espnEventId, setEspnEventId] = useState(initial?.espnEventId || null);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [searchError, setSearchError] = useState("");
  const [oddsEvent, setOddsEvent] = useState(null);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError] = useState("");
  const [oddsPicked, setOddsPicked] = useState(null);
  async function runSearch() {
    setSearching(true);
    setSearchError("");
    // A fresh search means "start over" — clear anything tied to a previously
    // selected game so it can't linger (like an old date silently filtering
    // out the new search, or stale odds/props still showing).
    setTeam("");
    setOpponent("");
    setGameDate("");
    setKickoffTime("");
    setEspnEventId(null);
    setOdds("");
    setLine("");
    setNotes("");
    setOddsEvent(null);
    setOddsError("");
    setOddsPicked(null);
    setPropRows(null);
    setPropError("");
    setPropPicked(null);
    try {
      const data = await fetchEspnScoreboard("");
      const options = (data?.events || []).map(eventToOption);
      const q = normalize(searchQuery);
      const filtered = q ? options.filter(o => normalize(o.home).includes(q) || normalize(o.away).includes(q)) : options;
      if (filtered.length === 0) setSearchError("No matching games found for that team.");
      setSearchResults(filtered);
    } catch {
      setSearchError("Couldn't reach the live schedule right now.");
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  }
  async function pickSide(opt, sideKey) {
    const parts = toLocalDateTimeParts(opt.isoDate);
    const myTeam = sideKey === "home" ? opt.home : opt.away;
    const oppTeam = sideKey === "home" ? opt.away : opt.home;
    setTeam(myTeam);
    setOpponent(oppTeam);
    setGameDate(parts.date);
    setKickoffTime(parts.time);
    setEspnEventId(opt.id);
    setSearchResults(null);
    setOddsEvent(null);
    setOddsError("");
    setOddsPicked(null);
    setPropRows(null);
    setPropPicked(null);
    if (oddsApiKey) {
      setOddsLoading(true);
      try {
        const events = await fetchOddsApiOdds(oddsApiKey);
        const match = findOddsApiOddsEvent(events, myTeam, oppTeam);
        if (match) setOddsEvent(match);else setOddsError("No live odds found for this game yet — bookmakers may not have posted lines.");
      } catch {
        setOddsError("Couldn't reach the live odds feed right now.");
      } finally {
        setOddsLoading(false);
      }
    }
  }
  function useOddsRow(row) {
    setOdds(row.odds);
    if (row.line != null && (betType === "spread" || betType === "total")) setLine(row.line);
    setOddsPicked(row);
  }
  const [propMarket, setPropMarket] = useState(PROP_MARKETS[0].key);
  const [propRows, setPropRows] = useState(null);
  const [propLoading, setPropLoading] = useState(false);
  const [propError, setPropError] = useState("");
  const [propPicked, setPropPicked] = useState(null);
  async function loadProps(marketKey) {
    if (!oddsApiKey || !oddsEvent?.id) return;
    setPropLoading(true);
    setPropError("");
    setPropRows(null);
    setPropPicked(null);
    try {
      const eventOdds = await fetchPlayerProps(oddsApiKey, oddsEvent.id, marketKey);
      const rows = propRowsForMarket(eventOdds, marketKey);
      if (rows.length === 0) setPropError("No props posted for this market yet — try again closer to kickoff.");
      setPropRows(rows);
    } catch {
      setPropError("Couldn't reach the live props feed right now.");
    } finally {
      setPropLoading(false);
    }
  }
  // Auto-load whenever the prop market changes, the game changes, or the bet type
  // switches to "prop" — no manual "Load" click needed.
  useEffect(() => {
    if (betType === "prop" && oddsApiKey && oddsEvent?.id) {
      loadProps(propMarket);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betType, propMarket, oddsEvent]);
  function usePropRow(row) {
    const marketLabel = PROP_MARKETS.find(m => m.key === propMarket)?.label || "";
    const desc = row.side ? `${row.player} ${row.side} ${row.line} ${marketLabel}` : `${row.player} — ${marketLabel}`;
    setNotes(desc);
    setOdds(row.odds);
    setPropPicked(row);
  }
  function submit() {
    if (!team.trim() || odds === "") {
      setError("Team and odds are required.");
      return;
    }
    onSubmit({
      betType,
      team: team.trim(),
      opponent: opponent.trim(),
      line: line === "" ? null : Number(line),
      side: betType === "total" ? side : null,
      odds: Number(odds),
      gameDate,
      kickoffTime,
      notes: notes.trim(),
      espnEventId,
      status: initial?.status && initial.status !== "pending" ? initial.status : "pending",
      finalScore: initial?.finalScore || null,
      live: null
    });
  }
  const oddsRows = oddsRowsForMarket(oddsEvent, betType, team, side);
  return /*#__PURE__*/React.createElement("div", {
    className: "bp-form"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Search NFL game (optional — auto-fills team, opponent, date & kickoff time)"), /*#__PURE__*/React.createElement("div", {
    className: "bp-search-row"
  }, /*#__PURE__*/React.createElement("input", {
    value: searchQuery,
    onChange: e => setSearchQuery(e.target.value),
    placeholder: "e.g. Chiefs",
    onKeyDown: e => e.key === "Enter" && runSearch()
  }), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn small",
    onClick: runSearch,
    disabled: searching,
    style: {
      flexShrink: 0
    }
  }, searching ? "…" : "Search")), searchError && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, searchError), searchResults && searchResults.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bp-search-results",
    style: {
      marginTop: 6
    }
  }, searchResults.map(opt => /*#__PURE__*/React.createElement("div", {
    className: "bp-search-item",
    key: opt.id
  }, /*#__PURE__*/React.createElement("span", null, new Date(opt.isoDate).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  })), /*#__PURE__*/React.createElement("div", {
    className: "bp-search-item-teams"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-search-pick",
    onClick: () => pickSide(opt, "away")
  }, opt.away), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ink-dim)"
    }
  }, "@"), /*#__PURE__*/React.createElement("span", {
    className: "bp-search-pick",
    onClick: () => pickSide(opt, "home")
  }, opt.home))))), /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Tap the team you're betting on to fill in the fields below."), !oddsApiKey && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Add an Odds API key (🔑 button in the header) to pull real bookmaker lines here.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Bet type"), /*#__PURE__*/React.createElement("select", {
    value: betType,
    onChange: e => {
      setBetType(e.target.value);
      setOddsPicked(null);
    }
  }, BET_TYPES.map(b => /*#__PURE__*/React.createElement("option", {
    key: b.id,
    value: b.id
  }, b.label)))), oddsApiKey && team && betType !== "prop" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Live odds", oddsPicked ? "" : ` — tap one to fill in Odds${betType !== "moneyline" ? " and the line" : ""}`), oddsLoading && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Loading odds…"), oddsError && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, oddsError), oddsPicked ? /*#__PURE__*/React.createElement("div", {
    className: "bp-odds-row picked"
  }, /*#__PURE__*/React.createElement("span", null, "Using ", oddsPicked.bookmaker, oddsPicked.line != null && betType !== "moneyline" ? ` · ${oddsPicked.line > 0 ? "+" : ""}${oddsPicked.line}` : "", " · ", oddsPicked.odds.toFixed(2)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "bp-odds-change",
    onClick: () => setOddsPicked(null)
  }, "Change")) : /*#__PURE__*/React.createElement(React.Fragment, null, !oddsLoading && oddsRows.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bp-odds-rows"
  }, oddsRows.map((row, i) => /*#__PURE__*/React.createElement("button", {
    type: "button",
    key: i,
    className: "bp-odds-row",
    onClick: () => useOddsRow(row)
  }, /*#__PURE__*/React.createElement("span", null, row.bookmaker), /*#__PURE__*/React.createElement("span", {
    className: "bp-odds-row-value"
  }, row.line != null && betType !== "moneyline" ? `${row.line > 0 ? "+" : ""}${row.line} · ` : "", row.odds.toFixed(2))))), !oddsLoading && !oddsError && oddsRows.length === 0 && oddsEvent && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "No bookmaker has posted a ", betType, " line for this game yet."))), oddsApiKey && team && betType === "prop" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Browse player props"), !oddsEvent && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Search and pick a game above first to browse its props."), oddsEvent && /*#__PURE__*/React.createElement(React.Fragment, null, propPicked ? /*#__PURE__*/React.createElement("div", {
    className: "bp-odds-row picked"
  }, /*#__PURE__*/React.createElement("span", null, "Using ", propPicked.player, " ", propPicked.side ? `${propPicked.side} ${propPicked.line}` : "", " (", propPicked.bookmaker, ") · ", propPicked.odds.toFixed(2)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "bp-odds-change",
    onClick: () => setPropPicked(null)
  }, "Change")) : /*#__PURE__*/React.createElement("div", {
    className: "bp-prop-browser"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-search-row"
  }, /*#__PURE__*/React.createElement("select", {
    value: propMarket,
    onChange: e => setPropMarket(e.target.value),
    style: {
      flex: 1
    }
  }, PROP_MARKETS.map(m => /*#__PURE__*/React.createElement("option", {
    key: m.key,
    value: m.key
  }, m.label))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "bp-btn ghost small",
    onClick: () => loadProps(propMarket),
    disabled: propLoading,
    style: {
      flexShrink: 0
    }
  }, propLoading ? "…" : "Refresh")), /*#__PURE__*/React.createElement("div", {
    className: "bp-prop-browser-divider"
  }), propLoading && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, "Loading props…"), propError && /*#__PURE__*/React.createElement("div", {
    className: "bp-hint"
  }, propError), !propLoading && propRows && propRows.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bp-odds-rows"
  }, propRows.map((row, i) => /*#__PURE__*/React.createElement("button", {
    type: "button",
    key: i,
    className: "bp-odds-row",
    onClick: () => usePropRow(row)
  }, /*#__PURE__*/React.createElement("span", null, row.player, " ", row.side ? `${row.side} ${row.line}` : "", " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ink-dim)"
    }
  }, "(", row.bookmaker, ")")), /*#__PURE__*/React.createElement("span", {
    className: "bp-odds-row-value"
  }, row.odds.toFixed(2)))))))), /*#__PURE__*/React.createElement("div", {
    className: "bp-form-row"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Your team / side"), /*#__PURE__*/React.createElement("input", {
    value: team,
    onChange: e => setTeam(e.target.value),
    placeholder: "Chiefs"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Opponent"), /*#__PURE__*/React.createElement("input", {
    value: opponent,
    onChange: e => setOpponent(e.target.value),
    placeholder: "Bills"
  }))), (betType === "spread" || betType === "total") && /*#__PURE__*/React.createElement("div", {
    className: "bp-form-row"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, betType === "spread" ? "Spread (e.g. -3.5)" : "Total line"), /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: "0.5",
    value: line,
    onChange: e => setLine(e.target.value)
  })), betType === "total" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Over / Under"), /*#__PURE__*/React.createElement("select", {
    value: side,
    onChange: e => {
      setSide(e.target.value);
      setOddsPicked(null);
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "over"
  }, "Over"), /*#__PURE__*/React.createElement("option", {
    value: "under"
  }, "Under")))), /*#__PURE__*/React.createElement("div", {
    className: "bp-form-row-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Odds (decimal)"), /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: "0.01",
    min: "1.01",
    value: odds,
    onChange: e => setOdds(e.target.value),
    placeholder: "1.91"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Game date"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: gameDate,
    onChange: e => setGameDate(e.target.value)
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Kickoff time"), /*#__PURE__*/React.createElement("input", {
    type: "time",
    value: kickoffTime,
    onChange: e => setKickoffTime(e.target.value)
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Notes (what's the actual bet — helps for props too)"), /*#__PURE__*/React.createElement("textarea", {
    rows: 2,
    value: notes,
    onChange: e => setNotes(e.target.value),
    placeholder: "Chiefs -3.5, or 'Mahomes over 2.5 passing TDs'"
  })), error && /*#__PURE__*/React.createElement("div", {
    className: "bp-error"
  }, error), /*#__PURE__*/React.createElement("button", {
    className: "bp-btn",
    onClick: submit
  }, "Save Bet"));
}
function MiniBarChart({
  rows
}) {
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.units)));
  return /*#__PURE__*/React.createElement("div", {
    className: "bp-chart-row"
  }, rows.map(r => {
    const heightPct = Math.max(6, Math.abs(r.units) / maxAbs * 100);
    const color = r.units >= 0 ? "linear-gradient(180deg, #34D3C8, #3E7BFA)" : "linear-gradient(180deg, #EA4C89, #7C5CFC)";
    return /*#__PURE__*/React.createElement("div", {
      className: "bp-chart-col",
      key: r.name
    }, /*#__PURE__*/React.createElement("span", {
      className: "bp-chart-value"
    }, r.units >= 0 ? "+" : "", r.units.toFixed(1)), /*#__PURE__*/React.createElement("div", {
      className: "bp-chart-bar",
      style: {
        height: `${heightPct}%`,
        background: color
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "bp-chart-label"
    }, r.name));
  }));
}
function StandingsTab({
  people,
  weeksList,
  seasonCache,
  totals,
  loading
}) {
  const [historySelection, setHistorySelection] = useState("");
  if (loading && Object.keys(seasonCache).length === 0) return /*#__PURE__*/React.createElement("div", null, "Loading season…");
  const rows = people.map(p => ({
    name: p.name,
    ...totals[p.name]
  })).sort((a, b) => b.units - a.units || b.win - a.win);
  const maxBozos = Math.max(0, ...rows.map(r => r.bozos || 0));
  const reigningBozos = maxBozos > 0 ? rows.filter(r => r.bozos === maxBozos).map(r => r.name) : [];
  const weeksWithData = weeksList.filter(w => seasonCache[w.id] && Object.keys(seasonCache[w.id].picks || {}).length > 0);
  const historyBets = historySelection && historySelection !== "__all__" ? weeksWithData.map(w => {
    const entry = seasonCache[w.id];
    const bet = entry.picks?.[historySelection];
    return bet ? {
      week: w.label,
      bet,
      wasBozo: entry.meta?.bozo === historySelection
    } : null;
  }).filter(Boolean) : [];
  return /*#__PURE__*/React.createElement("div", null, reigningBozos.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bp-bozo-callout"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bp-bozo-callout-icon"
  }, /*#__PURE__*/React.createElement(JesterHat, {
    size: 32
  })), /*#__PURE__*/React.createElement("span", {
    className: "bp-bozo-callout-text"
  }, "Reigning Bozo", reigningBozos.length > 1 ? "s" : "", ": ", /*#__PURE__*/React.createElement("b", null, reigningBozos.join(", ")), " (", maxBozos, "x this season)")), /*#__PURE__*/React.createElement("div", {
    className: "bp-standings-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-section-title",
    style: {
      marginBottom: 0
    }
  }, "Units by player"), /*#__PURE__*/React.createElement(MiniBarChart, {
    rows: rows
  })), /*#__PURE__*/React.createElement("div", {
    className: "bp-section-title"
  }, "Season Standings"), /*#__PURE__*/React.createElement("table", {
    className: "bp-lb-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null), /*#__PURE__*/React.createElement("th", null, "Player"), /*#__PURE__*/React.createElement("th", null, "W"), /*#__PURE__*/React.createElement("th", null, "L"), /*#__PURE__*/React.createElement("th", null, "P"), /*#__PURE__*/React.createElement("th", null, "Pending"), /*#__PURE__*/React.createElement("th", null, "🤡"), /*#__PURE__*/React.createElement("th", null, "Units"))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: r.name
  }, /*#__PURE__*/React.createElement("td", {
    className: "bp-lb-rank"
  }, i + 1), /*#__PURE__*/React.createElement("td", {
    className: "bp-lb-name"
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: r.name
  }), r.name), /*#__PURE__*/React.createElement("td", null, r.win), /*#__PURE__*/React.createElement("td", null, r.loss), /*#__PURE__*/React.createElement("td", null, r.push), /*#__PURE__*/React.createElement("td", null, r.pending), /*#__PURE__*/React.createElement("td", null, r.bozos || 0), /*#__PURE__*/React.createElement("td", {
    style: {
      color: r.units >= 0 ? "var(--cyan)" : "var(--pink)",
      fontWeight: 600
    }
  }, r.units >= 0 ? "+" : "", r.units.toFixed(2)))))), /*#__PURE__*/React.createElement("div", {
    className: "bp-section-title",
    style: {
      marginTop: 30
    }
  }, "Player History", /*#__PURE__*/React.createElement("select", {
    className: "bp-select",
    value: historySelection,
    onChange: e => setHistorySelection(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select a player…"), /*#__PURE__*/React.createElement("option", {
    value: "__all__"
  }, "All players (week by week)"), people.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.name,
    value: p.name
  }, p.name)))), historySelection === "__all__" && /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "bp-matrix-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Week"), people.map(p => /*#__PURE__*/React.createElement("th", {
    key: p.name
  }, p.name)))), /*#__PURE__*/React.createElement("tbody", null, weeksWithData.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: people.length + 1,
    style: {
      textAlign: "center",
      color: "var(--ink-dim)"
    }
  }, "No bets logged yet.")), weeksWithData.map(w => {
    const entry = seasonCache[w.id];
    return /*#__PURE__*/React.createElement("tr", {
      key: w.id
    }, /*#__PURE__*/React.createElement("td", null, w.label), people.map(p => {
      const bet = entry.picks?.[p.name];
      const isBozo = entry.meta?.bozo === p.name;
      return /*#__PURE__*/React.createElement("td", {
        key: p.name
      }, bet ? /*#__PURE__*/React.createElement("span", {
        className: "bp-matrix-cell"
      }, /*#__PURE__*/React.createElement(Badge, {
        status: bet.status,
        bet: bet
      }), isBozo && /*#__PURE__*/React.createElement(BozoFlair, {
        inline: true
      })) : /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--ink-dim)"
        }
      }, "—"));
    }));
  })))), historySelection && historySelection !== "__all__" && historyBets.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--ink-dim)",
      fontSize: 13
    }
  }, "No bets logged yet for ", historySelection, "."), historyBets.map(({
    week,
    bet,
    wasBozo
  }) => /*#__PURE__*/React.createElement("div", {
    key: week
  }, /*#__PURE__*/React.createElement("div", {
    className: "bp-history-week"
  }, week, " ", wasBozo && /*#__PURE__*/React.createElement(BozoFlair, {
    inline: true
  })), /*#__PURE__*/React.createElement("div", {
    className: "bp-history-row"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "bp-history-desc"
  }, bet.notes || `${bet.team} vs ${bet.opponent}`), /*#__PURE__*/React.createElement("div", {
    className: "bp-history-meta"
  }, oddsLabel(bet.odds), " ", bet.finalScore ? `· ${bet.finalScore}` : "")), /*#__PURE__*/React.createElement(Badge, {
    status: bet.status,
    bet: bet
  })))));
}
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(/*#__PURE__*/React.createElement(App, null));