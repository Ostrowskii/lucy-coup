import { VibiNet } from "./vendor/vibinet.mjs";

const ROOM = "coup-1";
const SERVER = "wss://net.vibistudiotest.site";
const MAX_PLAYERS = 3;
const TICK_RATE = 6;
const TOLERANCE = 400;
const HEARTBEAT_MS = 2000;
const STALE_TICKS = TICK_RATE * 8;
const STORAGE_NAME = "lucy-coup-name";
const STORAGE_ID = "lucy-coup-player-id";
const STORAGE_SEED = "lucy-coup-seed";
const STARTING_COINS = 2;
const COIN_ASSET = "./assets/lucycurrency%20(1).png";

const ROLE_INFO = {
  duke: { label: "Duque", assets: ["./assets/duquesa2.png"] },
  assassin: { label: "Assassino", assets: ["./assets/catassassin.png"] },
  captain: { label: "Capitão", assets: ["./assets/captao2wand.png"] },
  ambassador: { label: "Embaixador", assets: ["./assets/embaixador.jpeg"] },
  contessa: { label: "Condessa", assets: ["./assets/condessa2.png"] },
  inquisitor: {
    label: "Inquisidor",
    assets: [
      "./assets/catinquisitor1.png",
      "./assets/catinquisitor2.png",
      "./assets/catinquisitor3.png",
    ],
  },
};

function cardAsset(role, cardId) {
  const assets = ROLE_INFO[role]?.assets;
  if (!assets || assets.length === 0) return "";
  const idx = typeof cardId === "number" ? (cardId - 1) % assets.length : 0;
  return assets[(idx + assets.length) % assets.length];
}

const ACTION_INFO = {
  income: { label: "Renda", text: "+1 moeda" },
  foreign_aid: { label: "Ajuda externa", text: "+2 moedas" },
  tax: { label: "Imposto", text: "Duque: +3 moedas", role: "duke" },
  steal: { label: "Roubar", text: "Capitão: pega 2", role: "captain", needsTarget: true },
  assassinate: { label: "Assassinar", text: "Assassino: custa 3", role: "assassin", needsTarget: true, cost: 3 },
  exchange: { label: "Trocar", text: "Inquisidor: pega 1 e devolve 1", role: "inquisitor" },
  investigate: { label: "Investigar", text: "Inquisidor: olha 1 carta", role: "inquisitor", needsTarget: true },
  coup: { label: "Golpe", text: "Custa 7 moedas", needsTarget: true, cost: 7 },
};

const ACTION_ORDER = ["income", "foreign_aid", "tax", "steal", "assassinate", "coup", "exchange", "investigate"];

const POST_PACKER = {
  $: "Union",
  variants: {
    join: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        name: { $: "String" },
      },
    },
    heartbeat: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        name: { $: "String" },
      },
    },
    ready: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        ready: { $: "Nat" },
      },
    },
    set_seed: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        seed: { $: "String" },
      },
    },
    action: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        action: { $: "String" },
        targetId: { $: "String" },
      },
    },
    challenge: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
      },
    },
    pass: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
      },
    },
    block: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        role: { $: "String" },
      },
    },
    reveal: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        cardId: { $: "Nat" },
      },
    },
    show_claimed_role: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
      },
    },
    confirm_revealed: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
      },
    },
    exchange: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        keepA: { $: "Nat" },
        keepB: { $: "Nat" },
      },
    },
    investigate_decision: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        force: { $: "Nat" },
      },
    },
    investigate_pick: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        cardId: { $: "Nat" },
      },
    },
    forfeit: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
      },
    },
  },
};

const INITIAL_STATE = {
  tick: 0,
  phase: "lobby",
  round: 0,
  seed: "",
  rngCounter: 0,
  players: {},
  playerOrder: [],
  currentPlayerId: "",
  turnNumber: 0,
  pending: null,
  deck: [],
  log: [],
  winnerId: "",
};

const root = document.querySelector("#app");

const session = {
  playerId: getStoredPlayerId(),
  nameDraft: sessionStorage.getItem(STORAGE_NAME) || "",
  seedDraft: sessionStorage.getItem(STORAGE_SEED) || makeSeed(),
  joined: false,
  syncReady: false,
  helpOpen: false,
  selectedAction: "",
  selectedTargetId: "",
  exchangeSelection: [],
  revealOwnCards: false,
  cardModal: null,
  currentState: INITIAL_STATE,
  renderStateRef: null,
  lastMarkup: "",
  lastUiKey: "",
  seedPosted: "",
  joinSubmitted: false,
  heartbeatTimer: null,
};

const game = new VibiNet.game({
  server: SERVER,
  room: ROOM,
  initial: INITIAL_STATE,
  on_tick,
  on_post,
  packer: POST_PACKER,
  tick_rate: TICK_RATE,
  tolerance: TOLERANCE,
});

game.on_sync(() => {
  session.syncReady = true;
  if (session.joined) {
    postJoin();
    sendHeartbeat();
  }
});

document.addEventListener("click", onDocumentClick);
document.addEventListener("submit", onDocumentSubmit);
document.addEventListener("input", onDocumentInput);

session.lastMarkup = renderApp(session.currentState);
root.innerHTML = session.lastMarkup;
requestAnimationFrame(renderLoop);

function on_tick(state) {
  let next = { ...state, tick: state.tick + 1 };
  next = refreshConnections(next);
  next = maybeStartRound(next);
  next = maybeResolvePending(next);
  next = maybeAdvanceTurn(next);
  next = maybeFinishRound(next);
  return next;
}

function on_post(post, state) {
  switch (post.$) {
    case "join":
      return handleJoin(state, post.playerId, post.name);
    case "heartbeat":
      return handleHeartbeat(state, post.playerId, post.name);
    case "ready":
      return handleReady(state, post.playerId, !!post.ready);
    case "set_seed":
      return handleSetSeed(state, post.playerId, post.seed);
    case "action":
      return handleAction(state, post.playerId, post.action, post.targetId);
    case "challenge":
      return handleChallenge(state, post.playerId);
    case "pass":
      return handlePass(state, post.playerId);
    case "block":
      return handleBlock(state, post.playerId, post.role);
    case "reveal":
      return handleReveal(state, post.playerId, post.cardId);
    case "show_claimed_role":
      return handleShowClaimedRole(state, post.playerId);
    case "confirm_revealed":
      return handleConfirmRevealed(state, post.playerId);
    case "exchange":
      return handleExchange(state, post.playerId, post.keepA, post.keepB);
    case "investigate_decision":
      return handleInvestigateDecision(state, post.playerId, !!post.force);
    case "investigate_pick":
      return handleInvestigatePick(state, post.playerId, post.cardId);
    case "forfeit":
      return handleForfeit(state, post.playerId);
    default:
      return state;
  }
}

function handleJoin(state, playerId, name) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return state;
  const existing = state.players[playerId];
  if (existing) {
    const changed = existing.name !== cleanName;
    const canResetReady = state.phase === "lobby" || state.phase === "game_over";
    const nextPlayer = {
      ...existing,
      name: cleanName,
      lastSeenTick: state.tick,
      connected: true,
      ready: canResetReady && changed ? false : existing.ready,
    };
    return withPlayer(state, playerId, nextPlayer);
  }
  if (state.phase === "in_game") return state;
  if (countConnectedLobbyPlayers(state) >= MAX_PLAYERS) return state;
  const joinIndex = state.playerOrder.length;
  const player = {
    id: playerId,
    name: cleanName,
    joinIndex,
    ready: false,
    connected: true,
    lastSeenTick: state.tick,
    coins: 0,
    hand: [],
    inMatch: false,
  };
  const next = {
    ...state,
    players: { ...state.players, [playerId]: player },
    playerOrder: [...state.playerOrder, playerId],
  };
  return pushLog(next, `${cleanName} entrou.`);
}

function handleHeartbeat(state, playerId, name) {
  const cleanName = sanitizeName(name);
  const existing = state.players[playerId];
  if (!existing) return handleJoin(state, playerId, cleanName);
  const changed = cleanName && cleanName !== existing.name;
  const canResetReady = state.phase === "lobby" || state.phase === "game_over";
  const nextPlayer = {
    ...existing,
    name: cleanName || existing.name,
    lastSeenTick: state.tick,
    connected: true,
    ready: canResetReady && changed ? false : existing.ready,
  };
  return withPlayer(state, playerId, nextPlayer);
}

function handleReady(state, playerId, ready) {
  const player = state.players[playerId];
  if (!player) return state;
  if (state.phase !== "lobby" && state.phase !== "game_over") return state;
  const nextPlayer = { ...player, ready };
  return withPlayer(state, playerId, nextPlayer);
}

function handleSetSeed(state, playerId, seed) {
  if (state.phase !== "lobby" && state.phase !== "game_over") return state;
  if (getHostPlayerId(state) !== playerId) return state;
  if (!seed) return state;
  return { ...state, seed: seed.slice(0, 64) };
}

function handleAction(state, playerId, action, targetId) {
  if (state.phase !== "in_game" || state.pending) return state;
  if (state.currentPlayerId !== playerId) return state;
  const actor = state.players[playerId];
  const info = ACTION_INFO[action];
  if (!actor || !info || !isTurnEligible(actor)) return state;
  if (actor.coins >= 10 && action !== "coup") return state;
  if ((info.cost || 0) > actor.coins) return state;
  if (info.needsTarget) {
    if (!isValidTarget(state, playerId, targetId)) return state;
  }
  const nextActor = { ...actor, coins: actor.coins - (info.cost || 0) };
  let next = withPlayer(state, playerId, nextActor);
  const ctx = { action, actorId: playerId, targetId: targetId || "" };
  if (info.role) {
    const eligibleIds = getChallengersForAction(next, playerId);
    next = {
      ...next,
      pending: {
        type: "challenge_action",
        actionCtx: ctx,
        role: info.role,
        passedIds: [],
        eligibleIds,
      },
    };
    return pushLog(next, describeActionClaim(next, ctx, info.role));
  }
  return beginBlockOrResolve(pushLog(next, `${actor.name} usou ${info.label.toLowerCase()}.`), ctx);
}

function handleChallenge(state, playerId) {
  if (state.phase !== "in_game" || !state.pending) return state;
  const player = state.players[playerId];
  if (!player || !player.connected || !player.inMatch || getHiddenCards(player).length === 0) return state;
  if (state.pending.type === "challenge_action") {
    if (!state.pending.eligibleIds.includes(playerId)) return state;
    if (state.pending.passedIds.includes(playerId)) return state;
    return resolveActionChallenge(state, playerId);
  }
  if (state.pending.type === "challenge_block") {
    if (!state.pending.eligibleIds.includes(playerId)) return state;
    if (state.pending.passedIds.includes(playerId)) return state;
    return resolveBlockChallenge(state, playerId);
  }
  return state;
}

function handlePass(state, playerId) {
  if (state.phase !== "in_game" || !state.pending) return state;
  if (
    state.pending.type !== "challenge_action" &&
    state.pending.type !== "block_choice" &&
    state.pending.type !== "challenge_block"
  ) {
    return state;
  }
  if (!state.pending.eligibleIds.includes(playerId)) return state;
  if (state.pending.passedIds.includes(playerId)) return state;
  const pending = {
    ...state.pending,
    passedIds: [...state.pending.passedIds, playerId],
  };
  return maybeResolvePending({ ...state, pending });
}

function handleBlock(state, playerId, role) {
  if (state.phase !== "in_game" || !state.pending || state.pending.type !== "block_choice") return state;
  if (!state.pending.eligibleIds.includes(playerId)) return state;
  if (state.pending.passedIds.includes(playerId)) return state;
  const allowedRoles = getAllowedBlocks(state.pending.actionCtx.action, state.pending.actionCtx.targetId);
  if (!allowedRoles.includes(role)) return state;
  const blocker = state.players[playerId];
  const eligibleIds = getChallengersForBlock(state, playerId, state.pending.actionCtx.actorId);
  const next = {
    ...state,
    pending: {
      type: "challenge_block",
      actionCtx: state.pending.actionCtx,
      blockerId: playerId,
      role,
      passedIds: [],
      eligibleIds,
    },
  };
  return pushLog(next, describeBlockClaim(next, playerId, role, state.pending.actionCtx));
}

function handleReveal(state, playerId, cardId) {
  if (!state.pending || state.pending.type !== "reveal" || state.pending.playerId !== playerId) return state;
  const player = state.players[playerId];
  const card = player?.hand.find((entry) => !entry.revealed && entry.id === cardId);
  if (!card) return state;
  return {
    ...state,
    pending: {
      type: "discard_revealed",
      playerId,
      cardId,
      role: card.role,
      reason: state.pending.reason,
      continuation: state.pending.continuation,
    },
  };
}

function handleShowClaimedRole(state, playerId) {
  if (!state.pending || state.pending.type !== "claim_proof" || state.pending.playerId !== playerId) return state;
  const player = state.players[playerId];
  const card = player?.hand.find((entry) => !entry.revealed && entry.role === state.pending.role);
  if (!player || !card) return { ...state, pending: null };
  return pushLog(
    {
      ...state,
      pending: {
        type: "claim_replace",
        playerId,
        role: state.pending.role,
        cardId: card.id,
        challengerId: state.pending.challengerId,
        continuation: state.pending.continuation,
      },
    },
    `${player.name} mostrou ${roleLabel(state.pending.role)}.`,
  );
}

function handleConfirmRevealed(state, playerId) {
  if (!state.pending) return state;
  if (state.pending.type === "claim_replace" && state.pending.playerId === playerId) {
    const player = state.players[playerId];
    if (!player) return { ...state, pending: null };
    let next = replaceSpecificCard({ ...state, pending: null }, playerId, state.pending.cardId);
    next = pushLog(next, `${player.name} devolveu ${roleLabel(state.pending.role)} ao monte e comprou uma carta nova.`);
    return beginReveal(
      next,
      state.pending.challengerId,
      {
        promptTitle: `${player.name} mostrou que tinha ${roleLabel(state.pending.role)}. Você perdeu o desafio. Escolha qual influência revelar para descartar.`,
        bannerText: `${playerLabel(next, state.pending.challengerId)} perdeu o desafio para ${player.name} e precisa revelar 1 influência.`,
        discardText: `${playerLabel(next, state.pending.challengerId)} perdeu o desafio para ${player.name}.`,
      },
      state.pending.continuation,
    );
  }
  if (state.pending.type === "discard_revealed" && state.pending.playerId === playerId) {
    return applyDiscardChoice(state, playerId, state.pending.cardId, state.pending.reason, state.pending.continuation);
  }
  return state;
}

function handleExchange(state, playerId, keepA, keepB) {
  if (!state.pending || state.pending.type !== "exchange" || state.pending.playerId !== playerId) return state;
  const player = state.players[playerId];
  if (!player) return state;
  const hidden = getHiddenCards(player);
  const keepCount = state.pending.keepCount;
  if (keepCount === 2 && keepA === keepB) return state;
  const pool = [...hidden, ...state.pending.drawn];
  const keepIds = keepCount === 1 ? [keepA] : [keepA, keepB];
  const keep = keepIds.map((id) => pool.find((card) => card.id === id)).filter(Boolean);
  if (keep.length !== keepCount) return state;
  const keepSet = new Set(keepIds);
  const returned = pool.filter((card) => !keepSet.has(card.id));
  let deck = [...state.deck];
  let rngCounter = state.rngCounter;
  for (const card of returned) {
    const inserted = insertAtRandom(deck, card, state.seed, rngCounter);
    deck = inserted.deck;
    rngCounter = inserted.rngCounter;
  }
  const revealed = player.hand.filter((card) => card.revealed);
  const nextPlayer = {
    ...player,
    hand: [...revealed, ...keep.map((card) => ({ ...card, revealed: false }))],
  };
  let next = withPlayer({ ...state, pending: null, deck, rngCounter }, playerId, nextPlayer);
  next = pushLog(next, `${player.name} trocou cartas.`);
  return finishTurn(next);
}

function handleInvestigatePick(state, playerId, cardId) {
  if (!state.pending || state.pending.type !== "investigate_pick" || state.pending.actorId !== playerId) return state;
  const target = state.players[state.pending.targetId];
  if (!target) return { ...state, pending: null };
  const card = target.hand.find((entry) => entry.id === cardId && !entry.revealed);
  if (!card) return state;
  return {
    ...state,
    pending: {
      type: "investigate",
      actorId: state.pending.actorId,
      targetId: state.pending.targetId,
      cardId: card.id,
    },
  };
}

function handleInvestigateDecision(state, playerId, force) {
  if (!state.pending || state.pending.type !== "investigate" || state.pending.actorId !== playerId) return state;
  const actor = state.players[playerId];
  const target = state.players[state.pending.targetId];
  if (!actor || !target) return { ...state, pending: null };
  if (!force) {
    const next = pushLog({ ...state, pending: null }, `${actor.name} investigou ${target.name} e não forçou troca.`);
    return finishTurn(next);
  }
  const next = replaceSpecificCard({ ...state, pending: null }, target.id, state.pending.cardId);
  return finishTurn(pushLog(next, `${actor.name} investigou ${target.name} e forçou a troca da carta vista.`));
}

function refreshConnections(state) {
  let players = state.players;
  let changed = false;
  for (const [playerId, player] of Object.entries(state.players)) {
    const connected = state.tick - player.lastSeenTick <= STALE_TICKS;
    if (player.connected !== connected) {
      if (!changed) players = { ...players };
      players[playerId] = { ...player, connected };
      changed = true;
    }
  }
  return changed ? { ...state, players } : state;
}

function maybeStartRound(state) {
  if (state.phase !== "lobby" && state.phase !== "game_over") return state;
  const activeIds = getConnectedLobbyIds(state);
  if (activeIds.length < 2) return state;
  if (!activeIds.every((playerId) => state.players[playerId]?.ready)) return state;
  const seed = state.seed || "coup";
  const cards = buildDeck();
  const shuffled = shuffleDeck(cards, seed, state.rngCounter);
  let deck = shuffled.deck;
  let players = { ...state.players };
  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    if (!player) continue;
    if (!activeIds.includes(playerId)) {
      players[playerId] = { ...player, ready: false, inMatch: false, coins: 0, hand: [] };
      continue;
    }
    const hand = deck.slice(0, 2);
    deck = deck.slice(2);
    players[playerId] = {
      ...player,
      ready: false,
      inMatch: true,
      coins: STARTING_COINS,
      hand: hand.map((card) => ({ ...card, revealed: false })),
    };
  }
  let next = {
    ...state,
    phase: "in_game",
    round: state.round + 1,
    winnerId: "",
    pending: null,
    deck,
    players,
    currentPlayerId: activeIds[0],
    turnNumber: 1,
    rngCounter: shuffled.rngCounter,
    log: [],
  };
  next = pushLog(next, `Partida ${state.round + 1} começou.`);
  return pushLog(next, `${players[activeIds[0]].name} é o P1.`);
}

function maybeResolvePending(state) {
  if (!state.pending) return state;
  if (state.pending.type === "challenge_action") {
    const eligibleIds = getChallengersForAction(state, state.pending.actionCtx.actorId);
    const pending = { ...state.pending, eligibleIds };
    if (eligibleIds.every((playerId) => pending.passedIds.includes(playerId))) {
      return resolveActionClaimPassed({ ...state, pending });
    }
    return { ...state, pending };
  }
  if (state.pending.type === "block_choice") {
    const eligibleIds = getEligibleBlockers(state, state.pending.actionCtx);
    const pending = { ...state.pending, eligibleIds };
    if (eligibleIds.length === 0 || eligibleIds.every((playerId) => pending.passedIds.includes(playerId))) {
      return resolveActionEffect({ ...state, pending: null }, state.pending.actionCtx);
    }
    return { ...state, pending };
  }
  if (state.pending.type === "challenge_block") {
    const eligibleIds = getChallengersForBlock(state, state.pending.blockerId, state.pending.actionCtx.actorId);
    const pending = { ...state.pending, eligibleIds };
    if (eligibleIds.every((playerId) => pending.passedIds.includes(playerId))) {
      let next = pushLog({ ...state, pending: null }, `Bloqueio mantido.`);
      return finishTurn(next);
    }
    return { ...state, pending };
  }
  if (state.pending.type === "claim_proof") {
    const player = state.players[state.pending.playerId];
    if (!player) return resolveContinuation({ ...state, pending: null }, state.pending.continuation);
    if (!player.connected) {
      return handleShowClaimedRole(state, player.id);
    }
  }
  if (state.pending.type === "claim_replace") {
    const player = state.players[state.pending.playerId];
    if (!player) return resolveContinuation({ ...state, pending: null }, state.pending.continuation);
    if (!player.connected) {
      return handleConfirmRevealed(state, player.id);
    }
  }
  if (state.pending.type === "reveal") {
    const player = state.players[state.pending.playerId];
    if (!player) return resolveContinuation({ ...state, pending: null }, state.pending.continuation);
    const hidden = getHiddenCards(player);
    if (hidden.length === 0) {
      return resolveContinuation({ ...state, pending: null }, state.pending.continuation);
    }
    if (!player.connected) {
      return handleReveal(state, player.id, hidden[0].id);
    }
  }
  if (state.pending.type === "discard_revealed") {
    const player = state.players[state.pending.playerId];
    if (!player) return resolveContinuation({ ...state, pending: null }, state.pending.continuation);
    if (!player.connected) {
      return handleConfirmRevealed(state, player.id);
    }
  }
  if (state.pending.type === "exchange") {
    const player = state.players[state.pending.playerId];
    if (!player) return { ...state, pending: null };
    if (!player.connected) {
      const pool = [...getHiddenCards(player), ...state.pending.drawn].map((card) => card.id);
      return handleExchange(state, player.id, pool[0], state.pending.keepCount > 1 ? pool[1] : 0);
    }
  }
  if (state.pending.type === "investigate") {
    const actor = state.players[state.pending.actorId];
    if (!actor || !actor.connected) {
      return finishTurn({ ...state, pending: null });
    }
  }
  return state;
}

function maybeAdvanceTurn(state) {
  if (state.phase !== "in_game") return state;
  if (state.pending) return state;
  const current = state.players[state.currentPlayerId];
  if (current && isTurnEligible(current)) return state;
  return finishTurn(state, true);
}

function handleForfeit(state, playerId) {
  if (state.phase !== "in_game") return state;
  const player = state.players[playerId];
  if (!player || !player.inMatch) return state;
  if (getHiddenCards(player).length === 0) return state;
  const hand = player.hand.map((card) => ({ ...card, revealed: true }));
  let next = withPlayer(state, playerId, { ...player, hand });
  next = pushLog(next, `${player.name} desistiu.`);
  if (
    next.pending &&
    (next.pending.playerId === playerId ||
      next.pending.actorId === playerId ||
      next.pending.targetId === playerId ||
      next.pending.challengerId === playerId)
  ) {
    next = { ...next, pending: null };
  }
  const finished = maybeFinishRound(next);
  if (finished.phase === "game_over") return finished;
  if (finished.currentPlayerId === playerId) {
    return finishTurn(finished);
  }
  return maybeAdvanceTurn(finished);
}

function maybeFinishRound(state) {
  if (state.phase !== "in_game") return state;
  const aliveIds = getAliveConnectedIds(state);
  if (aliveIds.length > 1) return state;
  const winnerId = aliveIds[0] || "";
  const players = { ...state.players };
  for (const playerId of Object.keys(players)) {
    players[playerId] = { ...players[playerId], ready: false, inMatch: false };
  }
  let next = {
    ...state,
    phase: "game_over",
    players,
    winnerId,
    pending: null,
    currentPlayerId: "",
  };
  if (winnerId && state.players[winnerId]) {
    next = pushLog(next, `${state.players[winnerId].name} venceu.`);
  }
  return next;
}

function resolveActionClaimPassed(state) {
  const pending = state.pending;
  if (!pending || pending.type !== "challenge_action") return state;
  return beginBlockOrResolve({ ...state, pending: null }, pending.actionCtx);
}

function resolveActionChallenge(state, challengerId) {
  const pending = state.pending;
  if (!pending || pending.type !== "challenge_action") return state;
  const actor = state.players[pending.actionCtx.actorId];
  const challenger = state.players[challengerId];
  if (!actor) return { ...state, pending: null };
  if (playerHasRole(actor, pending.role)) {
    return {
      ...state,
      pending: {
        type: "claim_proof",
        playerId: actor.id,
        role: pending.role,
        challengerId,
        continuation: {
          type: "after_claim_proved",
          actionCtx: pending.actionCtx,
        },
      },
    };
  }
  let next = pushLog(
    { ...state, pending: null },
    `${actor.name} blefou que tinha ${roleLabel(pending.role)} e ${challenger ? challenger.name : "alguém"} pegou a mentira.`,
  );
  return beginReveal(next, actor.id, {
    promptTitle: `Você blefou que tinha ${roleLabel(pending.role)} e ${challenger ? challenger.name : "alguém"} duvidou de você. Escolha qual influência revelar para descartar.`,
    bannerText: `${actor.name} blefou que tinha ${roleLabel(pending.role)} e foi pego na mentira. Precisa revelar 1 influência.`,
    discardText: `${actor.name} blefou que tinha ${roleLabel(pending.role)} e foi pego na mentira.`,
  }, {
    type: "end_turn",
  });
}

function resolveBlockChallenge(state, challengerId) {
  const pending = state.pending;
  if (!pending || pending.type !== "challenge_block") return state;
  const blocker = state.players[pending.blockerId];
  const challenger = state.players[challengerId];
  if (!blocker) return { ...state, pending: null };
  if (playerHasRole(blocker, pending.role)) {
    return {
      ...state,
      pending: {
        type: "claim_proof",
        playerId: blocker.id,
        role: pending.role,
        challengerId,
        continuation: {
          type: "end_turn",
        },
      },
    };
  }
  let next = pushLog(
    { ...state, pending: null },
    `${blocker.name} blefou que tinha ${roleLabel(pending.role)} para bloquear e ${challenger ? challenger.name : "alguém"} pegou a mentira.`,
  );
  return beginReveal(next, blocker.id, {
    promptTitle: `Você blefou que tinha ${roleLabel(pending.role)} e ${challenger ? challenger.name : "alguém"} duvidou de você. Escolha qual influência revelar para descartar.`,
    bannerText: `${blocker.name} blefou que tinha ${roleLabel(pending.role)} e foi pego na mentira. Precisa revelar 1 influência.`,
    discardText: `${blocker.name} blefou que tinha ${roleLabel(pending.role)} e foi pego na mentira.`,
  }, {
    type: "resolve_action",
    actionCtx: pending.actionCtx,
  });
}

function beginBlockOrResolve(state, actionCtx) {
  const eligibleIds = getEligibleBlockers(state, actionCtx);
  if (eligibleIds.length === 0) {
    return resolveActionEffect(state, actionCtx);
  }
  const next = {
    ...state,
    pending: {
      type: "block_choice",
      actionCtx,
      passedIds: [],
      eligibleIds,
    },
  };
  if (actionCtx.action === "foreign_aid") {
    return pushLog(next, `Qualquer jogador pode bloquear com Duque.`);
  }
  return pushLog(next, `Alvo pode bloquear.`);
}

function resolveActionEffect(state, actionCtx) {
  const actor = state.players[actionCtx.actorId];
  if (!actor) return state;
  switch (actionCtx.action) {
    case "income": {
      const next = withPlayer(state, actor.id, { ...actor, coins: actor.coins + 1 });
      return finishTurn(pushLog(next, `${actor.name} ganhou 1 moeda.`));
    }
    case "foreign_aid": {
      const next = withPlayer(state, actor.id, { ...actor, coins: actor.coins + 2 });
      return finishTurn(pushLog(next, `${actor.name} ganhou 2 moedas.`));
    }
    case "tax": {
      const next = withPlayer(state, actor.id, { ...actor, coins: actor.coins + 3 });
      return finishTurn(pushLog(next, `${actor.name} ganhou 3 moedas.`));
    }
    case "steal": {
      const target = state.players[actionCtx.targetId];
      if (!target || !isTurnEligible(target)) return finishTurn(state);
      const taken = Math.min(2, target.coins);
      let next = withPlayer(state, actor.id, { ...actor, coins: actor.coins + taken });
      next = withPlayer(next, target.id, { ...target, coins: target.coins - taken });
      return finishTurn(pushLog(next, `${actor.name} roubou ${taken} moeda${taken === 1 ? "" : "s"} de ${target.name}.`));
    }
    case "assassinate": {
      const target = state.players[actionCtx.targetId];
      if (!target || !target.inMatch || getHiddenCards(target).length === 0) return finishTurn(state);
      const next = pushLog(state, `${actor.name} tentou eliminar uma influência de ${target.name}.`);
      return beginReveal(next, target.id, {
        promptTitle: `${actor.name} acertou o assassinato. Escolha qual influência revelar para descartar.`,
        bannerText: `${target.name} precisa revelar 1 influência por assassinato.`,
        discardText: `${target.name} perdeu uma influência por assassinato.`,
      }, { type: "end_turn" });
    }
    case "exchange": {
      const drawn = state.deck.slice(0, 1);
      const keepCount = getHiddenCards(actor).length;
      const next = {
        ...state,
        deck: state.deck.slice(1),
        pending: {
          type: "exchange",
          playerId: actor.id,
          drawn,
          keepCount,
        },
      };
      return pushLog(next, `${actor.name} comprou 1 carta para trocar.`);
    }
    case "investigate": {
      const target = state.players[actionCtx.targetId];
      if (!target || !target.inMatch) return finishTurn(state);
      const hidden = getHiddenCards(target);
      if (hidden.length === 0) return finishTurn(state);
      if (hidden.length === 1) {
        return {
          ...state,
          pending: {
            type: "investigate",
            actorId: actor.id,
            targetId: target.id,
            cardId: hidden[0].id,
          },
        };
      }
      return {
        ...state,
        pending: {
          type: "investigate_pick",
          actorId: actor.id,
          targetId: target.id,
        },
      };
    }
    case "coup": {
      const target = state.players[actionCtx.targetId];
      if (!target || !target.inMatch || getHiddenCards(target).length === 0) return finishTurn(state);
      const next = pushLog(state, `${actor.name} aplicou golpe em ${target.name}.`);
      return beginReveal(next, target.id, {
        promptTitle: `${actor.name} aplicou um golpe. Escolha qual influência revelar para descartar.`,
        bannerText: `${target.name} precisa revelar 1 influência por golpe.`,
        discardText: `${target.name} perdeu uma influência por golpe.`,
      }, { type: "end_turn" });
    }
    default:
      return state;
  }
}

function beginReveal(state, playerId, reason, continuation) {
  const player = state.players[playerId];
  if (!player) return resolveContinuation(state, continuation);
  const hidden = getHiddenCards(player);
  if (hidden.length === 0) return resolveContinuation(state, continuation);
  if (!player.connected) {
    return applyDiscardChoice({ ...state, pending: null }, playerId, hidden[0].id, reason, continuation);
  }
  return {
    ...state,
    pending: {
      type: "reveal",
      playerId,
      reason,
      continuation,
    },
  };
}

function applyDiscardChoice(state, playerId, cardId, reason, continuation) {
  const player = state.players[playerId];
  if (!player) return resolveContinuation({ ...state, pending: null }, continuation);
  const hand = player.hand.map((card) => (card.id === cardId ? { ...card, revealed: true } : card));
  const nextPlayer = { ...player, hand };
  let next = withPlayer({ ...state, pending: null }, playerId, nextPlayer);
  const revealed = hand.find((card) => card.id === cardId);
  next = pushLog(
    next,
    `${reason?.discardText || `${player.name} perdeu uma influência.`} Descartou ${revealed ? roleLabel(revealed.role) : "uma carta"}.`,
  );
  if (getHiddenCards(nextPlayer).length === 0) {
    next = pushLog(next, `${player.name} saiu da rodada.`);
  }
  return resolveContinuation(next, continuation);
}

function resolveContinuation(state, continuation) {
  if (!continuation) return state;
  if (continuation.type === "end_turn") return finishTurn(state);
  if (continuation.type === "after_claim_proved") return beginBlockOrResolve(state, continuation.actionCtx);
  if (continuation.type === "resolve_action") return resolveActionEffect(state, continuation.actionCtx);
  return state;
}

function finishTurn(state, keepCurrent = false) {
  if (state.phase !== "in_game") return state;
  const aliveIds = getAliveConnectedIds(state);
  if (aliveIds.length <= 1) return state;
  const order = state.playerOrder.filter((playerId) => aliveIds.includes(playerId));
  if (order.length === 0) return state;
  const currentIndex = order.indexOf(state.currentPlayerId);
  const nextId = keepCurrent || currentIndex === -1 ? order[0] : order[(currentIndex + 1) % order.length];
  const next = {
    ...state,
    pending: null,
    currentPlayerId: nextId,
    turnNumber: state.turnNumber + 1,
  };
  return next;
}

function replaceSpecificCard(state, playerId, cardId) {
  const player = state.players[playerId];
  if (!player) return state;
  const hand = [...player.hand];
  const index = hand.findIndex((card) => card.id === cardId);
  if (index === -1) return state;
  let deck = [...state.deck];
  let rngCounter = state.rngCounter;
  const returned = { ...hand[index], revealed: false };
  const inserted = insertAtRandom(deck, returned, state.seed, rngCounter);
  deck = inserted.deck;
  rngCounter = inserted.rngCounter;
  const replacement = deck[0];
  if (!replacement) return state;
  hand[index] = { ...replacement, revealed: false };
  deck = deck.slice(1);
  return withPlayer({ ...state, deck, rngCounter }, playerId, { ...player, hand });
}

function withPlayer(state, playerId, player) {
  return {
    ...state,
    players: { ...state.players, [playerId]: player },
  };
}

function pushLog(state, message) {
  const entry = {
    turn: state.turnNumber || 0,
    message,
  };
  const log = [...state.log, entry].slice(-18);
  return { ...state, log };
}

function getStoredPlayerId() {
  let id = sessionStorage.getItem(STORAGE_ID);
  if (id) return id;
  localStorage.removeItem(STORAGE_ID);
  id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem(STORAGE_ID, id);
  return id;
}

function sanitizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 18);
}

function makeSeed() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextRandom(seed, counter) {
  let x = (hashSeed(seed) + Math.imul(counter + 1, 2654435761)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489917) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function shuffleDeck(cards, seed, startCounter) {
  const deck = [...cards];
  let counter = startCounter;
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = nextRandom(seed, counter) % (i + 1);
    counter += 1;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return { deck, rngCounter: counter };
}

function insertAtRandom(deck, card, seed, startCounter) {
  const index = nextRandom(seed, startCounter) % (deck.length + 1);
  const nextDeck = [...deck];
  nextDeck.splice(index, 0, card);
  return { deck: nextDeck, rngCounter: startCounter + 1 };
}

function buildDeck() {
  const roles = ["duke", "assassin", "captain", "inquisitor", "contessa"];
  const cards = [];
  let cardId = 1;
  for (const role of roles) {
    for (let i = 0; i < 3; i += 1) {
      cards.push({ id: cardId, role, revealed: false });
      cardId += 1;
    }
  }
  return cards;
}

function getHostPlayerId(state) {
  return getConnectedLobbyIds(state)[0] || "";
}

function countConnectedLobbyPlayers(state) {
  return getConnectedLobbyIds(state).length;
}

function getConnectedLobbyIds(state) {
  return state.playerOrder.filter((playerId) => {
    const player = state.players[playerId];
    return player && player.connected;
  });
}

function getAliveConnectedIds(state) {
  return state.playerOrder.filter((playerId) => {
    const player = state.players[playerId];
    return player && isTurnEligible(player);
  });
}

function isTurnEligible(player) {
  return !!player && player.connected && player.inMatch && getHiddenCards(player).length > 0;
}

function getHiddenCards(player) {
  return (player?.hand || []).filter((card) => !card.revealed);
}

function playerHasRole(player, role) {
  return getHiddenCards(player).some((card) => card.role === role);
}

function getChallengersForAction(state, actorId) {
  return state.playerOrder.filter((playerId) => {
    const player = state.players[playerId];
    return playerId !== actorId && player && isTurnEligible(player);
  });
}

function getEligibleBlockers(state, actionCtx) {
  if (actionCtx.action === "foreign_aid") {
    return state.playerOrder.filter((playerId) => {
      const player = state.players[playerId];
      return playerId !== actionCtx.actorId && player && isTurnEligible(player);
    });
  }
  if (actionCtx.action === "steal" || actionCtx.action === "assassinate") {
    const target = state.players[actionCtx.targetId];
    return target && isTurnEligible(target) ? [target.id] : [];
  }
  return [];
}

function getAllowedBlocks(action, targetId) {
  if (action === "foreign_aid") return ["duke"];
  if (action === "steal") return ["captain", "inquisitor"];
  if (action === "assassinate" && targetId) return ["contessa"];
  return [];
}

function getChallengersForBlock(state, blockerId, actorId) {
  return state.playerOrder.filter((playerId) => {
    const player = state.players[playerId];
    return playerId !== blockerId && playerId !== actorId && player && isTurnEligible(player);
  }).concat(actorId && state.players[actorId] && isTurnEligible(state.players[actorId]) ? [actorId] : []).filter(uniqueValue);
}

function uniqueValue(value, index, list) {
  return list.indexOf(value) === index;
}

function isValidTarget(state, actorId, targetId) {
  if (!targetId || targetId === actorId) return false;
  const player = state.players[targetId];
  return !!player && isTurnEligible(player);
}

function roleLabel(role) {
  return ROLE_INFO[role]?.label || role;
}

function playerLabel(state, playerId) {
  const player = state.players[playerId];
  return player ? player.name : "Jogador";
}

function describeActionEffect(state, actionCtx) {
  const target = actionCtx.targetId ? state.players[actionCtx.targetId] : null;
  switch (actionCtx.action) {
    case "tax":
      return "vai pegar 3 moedas";
    case "steal":
      return `vai roubar 2 moedas de ${target ? target.name : "alguém"}`;
    case "assassinate":
      return `vai gastar 3 moedas para eliminar uma influência de ${target ? target.name : "alguém"}`;
    case "exchange":
      return "vai pegar 1 carta e devolver 1 para o monte";
    case "investigate":
      return `vai investigar 1 carta de ${target ? target.name : "alguém"}`;
    default:
      return `vai usar ${ACTION_INFO[actionCtx.action]?.label.toLowerCase() || "uma ação"}`;
  }
}

function describeActionClaim(state, actionCtx, role) {
  const actor = playerLabel(state, actionCtx.actorId);
  return `${actor} declarou que tem ${roleLabel(role)} e ${describeActionEffect(state, actionCtx)}.`;
}

function describeBlockClaim(state, blockerId, role, actionCtx) {
  const blocker = playerLabel(state, blockerId);
  if (actionCtx.action === "foreign_aid") {
    return `${blocker} declarou que tem ${roleLabel(role)} e vai bloquear a ajuda externa.`;
  }
  if (actionCtx.action === "steal") {
    return `${blocker} declarou que tem ${roleLabel(role)} e vai bloquear o roubo.`;
  }
  if (actionCtx.action === "assassinate") {
    return `${blocker} declarou que tem ${roleLabel(role)} e vai bloquear o assassinato.`;
  }
  return `${blocker} declarou que tem ${roleLabel(role)} e vai bloquear a ação.`;
}

function renderLoop() {
  const nextState = session.syncReady ? game.compute_render_state() : session.currentState;
  session.currentState = nextState;
  if (nextState.pending?.type !== "exchange" && session.exchangeSelection.length) {
    session.exchangeSelection = [];
  }
  if (nextState.currentPlayerId !== session.playerId || nextState.pending) {
    session.selectedAction = "";
    session.selectedTargetId = "";
  }
  syncHostSeed(nextState);
  const uiKey = [
    session.joined,
    session.helpOpen,
    session.selectedAction,
    session.selectedTargetId,
    session.exchangeSelection.join(","),
  ].join("|");
  const markup = renderApp(nextState);
  if (session.lastMarkup !== markup || session.lastUiKey !== uiKey) {
    const focusSnapshot = getFocusSnapshot();
    session.renderStateRef = nextState;
    session.lastMarkup = markup;
    session.lastUiKey = uiKey;
    root.innerHTML = markup;
    restoreFocusSnapshot(focusSnapshot);
  }
  requestAnimationFrame(renderLoop);
}

function getFocusSnapshot() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLTextAreaElement)) return null;
  if (!root.contains(active)) return null;
  return {
    name: active.name,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
  };
}

function restoreFocusSnapshot(snapshot) {
  if (!snapshot?.name) return;
  const next = root.querySelector(`[name="${CSS.escape(snapshot.name)}"]`);
  if (!(next instanceof HTMLInputElement) && !(next instanceof HTMLTextAreaElement)) return;
  next.focus({ preventScroll: true });
  if (typeof snapshot.selectionStart === "number" && typeof snapshot.selectionEnd === "number") {
    next.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}

function renderApp(state) {
  const me = state.players[session.playerId] || null;
  const connectedIds = getConnectedLobbyIds(state);
  const hostId = getHostPlayerId(state);
  const joinedAndAdmitted = !!me;
  return `
    <button class="help-button" data-action="open-help" aria-label="Abrir manual">?</button>
    <div class="screen">
      <header class="topbar">
        <h1 class="title">Siga o manuel -&gt;</h1>
      </header>

      ${
        !session.joined
          ? `
            <section class="panel join">
              <div>
                <h2>Entrar</h2>
                <p class="join__meta">Link abre direto na sala. Aqui só precisa do nome.</p>
              </div>
              <form id="join-form" class="join">
                <input
                  name="name"
                  placeholder="Seu nome"
                  maxlength="18"
                  autocomplete="nickname"
                  value="${escapeHtml(session.nameDraft)}"
                />
                <button type="submit">Entrar na coup</button>
              </form>
            </section>
          `
          : joinedAndAdmitted
            ? renderJoined(state, me, hostId)
            : `
              <section class="panel">
                <h2>Esperando vaga</h2>
                <p class="small">${
                  state.phase === "in_game"
                    ? "A rodada já começou. Tente de novo quando acabar."
                    : connectedIds.length >= MAX_PLAYERS
                      ? "A sala está cheia. No máximo 3 pessoas."
                      : "Tentando entrar..."
                }</p>
                <button class="secondary" data-action="retry-join">Tentar de novo</button>
              </section>
            `
      }
    </div>
    <div class="modal ${session.helpOpen ? "is-open" : ""}">
      <div class="modal__card">
        <img class="modal__image" src="./assets/manuel.jpeg" alt="Manual" />
        <button class="secondary" data-action="close-help">Fechar</button>
      </div>
    </div>
    ${renderCardModal()}
  `;
}

function renderCardModal() {
  const modal = session.cardModal;
  if (!modal) return "";
  const info = ROLE_INFO[modal.role];
  if (!info) return "";
  const assetSrc = cardAsset(modal.role, modal.cardId);
  return `
    <div class="modal is-open">
      <div class="modal__card">
        <img class="modal__image" src="${assetSrc}" alt="${escapeHtml(info.label)}" />
        <div class="section-title" style="text-align:center">${escapeHtml(info.label)}</div>
        <button class="secondary" data-action="close-card">Fechar</button>
      </div>
    </div>
  `;
}

function renderJoined(state, me, hostId) {
  if (state.phase === "lobby" || state.phase === "game_over") {
    return renderLobby(state, me, hostId);
  }
  return renderBoard(state, me);
}

function renderLobby(state, me, hostId) {
  const players = getConnectedLobbyIds(state)
    .map((playerId, index) => {
      const player = state.players[playerId];
      return `
        <div class="lobby-item">
          <div class="lobby-item__top">
            <strong>P${index + 1} · ${escapeHtml(player.name)}</strong>
            <div class="row">
              ${playerId === me.id ? '<span class="pill good">você</span>' : ""}
              ${playerId === hostId ? '<span class="pill">host</span>' : ""}
              <span class="pill ${player.ready ? "good" : ""}">${player.ready ? "pronto" : "esperando"}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
  return `
    <section class="panel">
      <div class="row">
        <div class="section-title">Jogadores</div>
        <div class="small">${getConnectedLobbyIds(state).length}/${MAX_PLAYERS}</div>
      </div>
      <div class="lobby-list">${players || '<div class="empty">Sem jogadores.</div>'}</div>
      ${state.phase === "game_over" && state.winnerId ? `<div class="small">${escapeHtml(playerLabel(state, state.winnerId))} venceu.</div>` : ""}
    </section>
    <div class="bottom-cta">
      <button class="${me.ready ? "secondary" : ""}" data-action="toggle-ready">Pronto</button>
    </div>
  `;
}

function renderBoard(state, me) {
  const players = state.playerOrder
    .map((playerId) => state.players[playerId])
    .filter((player) => player && player.inMatch);
  const activePlayers = players
    .filter((player) => getHiddenCards(player).length > 0)
    .map((player) => renderPlayerCard(player, state, me.id))
    .join("");
  const outPlayers = players
    .filter((player) => getHiddenCards(player).length === 0)
    .map((player) => renderPlayerCard(player, state, me.id, true))
    .join("");

  const canForfeit = me && me.inMatch && getHiddenCards(me).length > 0;
  return `
    <section class="panel board">
      ${outPlayers ? `<div class="player-strip">${outPlayers}</div>` : ""}
      <div class="player-grid">${activePlayers}</div>
    </section>
    ${renderActionPanel(state, me)}
    ${canForfeit ? `<div class="bottom-cta"><button class="secondary" data-action="forfeit">Desistir</button></div>` : ""}
  `;
}

function renderPlayerCard(player, state, myId, compact = false) {
  const hiddenCards = getHiddenCards(player);
  const isMe = player.id === myId;
  const showOwn = isMe && session.revealOwnCards;
  const cards = hiddenCards
    .map((card) => {
      const visible = showOwn;
      const info = ROLE_INFO[card.role];
      const assetSrc = cardAsset(card.role, card.id);
      const clickAttrs = visible
        ? `data-action="open-card" data-role="${escapeHtml(card.role)}" data-card-id="${card.id}"`
        : "";
      return `
        <div class="card ${visible ? "" : "card--hidden"}" ${clickAttrs}>
          ${visible ? `<img src="${assetSrc}" alt="${escapeHtml(info.label)}" />` : ""}
          ${visible ? `<div class="card__tag">${escapeHtml(info.label)}</div>` : ""}
        </div>
      `;
    })
    .join("");
  const showHideButton =
    isMe && hiddenCards.length > 0
      ? `<button class="secondary" data-action="toggle-own-cards">${showOwn ? "Hide" : "Show"}</button>`
      : "";
  return `
    <article class="player-card ${player.id === state.currentPlayerId ? "is-turn" : ""} ${isMe ? "is-me" : ""} ${
      hiddenCards.length === 0 ? "is-out" : ""
    } ${compact ? "is-compact" : ""}">
      <div class="player-card__top">
        <strong>${escapeHtml(player.name)}</strong>
        <div class="row">
          ${player.id === state.currentPlayerId ? '<span class="pill">turno</span>' : ""}
          ${!player.connected ? '<span class="pill">off</span>' : ""}
        </div>
      </div>
      <div class="row">
        <div class="coins">
          <span>${player.coins}</span>
          <div class="coin-stack">${Array.from(
            { length: Math.min(player.coins, 10) },
            () => `<img class="coin-token" src="${COIN_ASSET}" alt="Lucy currency" />`,
          ).join("")}</div>
        </div>
        <div class="small">${hiddenCards.length} influência</div>
      </div>
      ${cards ? `<div class="cards">${cards}</div>` : ""}
      ${showHideButton}
    </article>
  `;
}

function renderActionPanel(state, me) {
  const actionPrompt = renderActionPrompt(state, me);
  const responsePrompt = renderResponsePrompt(state, me);
  const pendingNotice = renderPendingNotice(state, me);
  const actionLog = renderActionLog(state);
  return `
    <section class="panel">
      <div class="section-title">Ações</div>
      ${responsePrompt || actionPrompt || pendingNotice || `<div class="empty">Vez de ${escapeHtml(playerLabel(state, state.currentPlayerId))}</div>`}
      ${actionLog}
    </section>
  `;
}

function renderActionLog(state) {
  const groups = groupLogsByTurn(state.log);
  if (groups.length === 0) return "";
  return `
    <div class="action-log">
      <div class="section-title">Últimas ações</div>
      <div class="log-list">
        ${groups
          .map(
            (group) => `
              <div class="log-turn">
                <div class="log-turn__title">Turno ${group.turn}</div>
                ${group.entries.map((entry) => `<div class="log-item">${escapeHtml(entry.message)}</div>`).join("")}
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function groupLogsByTurn(log) {
  const normalized = log
    .map((entry) =>
      typeof entry === "string"
        ? { turn: 0, message: entry }
        : { turn: entry.turn ?? 0, message: entry.message ?? "" },
    )
    .filter((entry) => entry.message);
  const groups = [];
  for (const entry of normalized) {
    let group = groups.find((item) => item.turn === entry.turn);
    if (!group) {
      group = { turn: entry.turn, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups
    .sort((a, b) => b.turn - a.turn)
    .map((group) => ({
      turn: group.turn,
      entries: group.entries.slice(-4).reverse(),
    }));
}

function renderActionPrompt(state, me) {
  if (state.currentPlayerId !== me.id || state.pending) return "";
  const opponents = getAliveConnectedIds(state).filter((playerId) => playerId !== me.id);
  const forceCoup = me.coins >= 10;
  const actions = ACTION_ORDER
    .filter((key) => !forceCoup || key === "coup")
    .map((key) => {
      const info = ACTION_INFO[key];
      const disabled =
        (info.cost || 0) > me.coins ||
        (!!info.needsTarget && opponents.length === 0);
      return `
        <button
          class="action-button ${key === session.selectedAction ? "choice-button is-active" : ""}"
          data-action="pick-action"
          data-value="${key}"
          ${disabled ? "disabled" : ""}
        >
          <span class="action-button__title">
            <span>${escapeHtml(info.label)}</span>
            ${info.role ? `<span class="action-button__role">${escapeHtml(roleLabel(info.role))}</span>` : ""}
          </span>
          <span>${escapeHtml(info.text)}</span>
        </button>
      `;
    })
    .join("");

  const selectedInfo = ACTION_INFO[session.selectedAction];
  const targetPicker =
    selectedInfo && selectedInfo.needsTarget
      ? `
        <div class="prompt">
          <strong>Escolha o alvo</strong>
          <div class="choice-list">
            ${opponents
              .map((playerId) => {
                const player = state.players[playerId];
                return `
                  <button
                    class="choice-button ${session.selectedTargetId === playerId ? "is-active" : ""}"
                    data-action="pick-target"
                    data-value="${playerId}"
                  >
                    ${escapeHtml(player.name)}
                  </button>
                `;
              })
              .join("")}
          </div>
          <button
            ${session.selectedTargetId ? "" : "disabled"}
            data-action="send-action"
          >
            Confirmar ${escapeHtml(selectedInfo.label.toLowerCase())}
          </button>
        </div>
      `
      : selectedInfo
        ? `
          <div class="prompt">
            <button data-action="send-action">Confirmar ${escapeHtml(selectedInfo.label.toLowerCase())}</button>
          </div>
        `
        : "";

  return `
    <div class="action-list">${actions}</div>
    ${targetPicker}
  `;
}

function renderResponsePrompt(state, me) {
  const pending = state.pending;
  if (!pending) return "";
  if (pending.type === "challenge_action" && pending.eligibleIds.includes(me.id)) {
    const hasPassed = pending.passedIds.includes(me.id);
    return `
      <div class="prompt">
        <strong>${escapeHtml(describeActionClaim(state, pending.actionCtx, pending.role))}</strong>
        <div class="choice-list">
          <button ${hasPassed ? "disabled" : ""} data-action="challenge">Desafiar</button>
          <button class="secondary" ${hasPassed ? "disabled" : 'data-action="pass"'}>${hasPassed ? "Você já passou" : "Passar"}</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "block_choice" && pending.eligibleIds.includes(me.id)) {
    const hasPassed = pending.passedIds.includes(me.id);
    const options = getAllowedBlocks(pending.actionCtx.action, pending.actionCtx.targetId);
    return `
      <div class="prompt">
        <strong>Você pode bloquear</strong>
        <div class="choice-list">
          ${options
            .map(
              (role) => `
                <button ${hasPassed ? "disabled" : ""} data-action="block" data-value="${role}">
                  Bloquear com ${escapeHtml(roleLabel(role))}
                </button>
              `,
            )
            .join("")}
          <button class="secondary" ${hasPassed ? "disabled" : 'data-action="pass"'}>${hasPassed ? "Você já passou" : "Não bloquear"}</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "challenge_block" && pending.eligibleIds.includes(me.id)) {
    const hasPassed = pending.passedIds.includes(me.id);
    return `
      <div class="prompt">
        <strong>${escapeHtml(describeBlockClaim(state, pending.blockerId, pending.role, pending.actionCtx))}</strong>
        <div class="choice-list">
          <button ${hasPassed ? "disabled" : ""} data-action="challenge">Desafiar bloqueio</button>
          <button class="secondary" ${hasPassed ? "disabled" : 'data-action="pass"'}>${hasPassed ? "Você já passou" : "Passar"}</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "claim_proof" && pending.playerId === me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(`${playerLabel(state, pending.challengerId)} duvidou de você. Mostre a carta ${roleLabel(pending.role)}.`)}</strong>
        <div class="choice-list">
          <button data-action="show-claimed-role">Mostrar carta ${escapeHtml(roleLabel(pending.role))}</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "claim_replace" && pending.playerId === me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(`Todos viram seu ${roleLabel(pending.role)}. Agora compre uma carta nova.`)}</strong>
        ${renderShownCard(pending.role, pending.cardId, `Carta mostrada: ${roleLabel(pending.role)}`)}
        <div class="choice-list">
          <button data-action="confirm-revealed">Comprar carta nova</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "reveal" && pending.playerId === me.id) {
    const player = state.players[me.id];
    return `
      <div class="prompt">
        <strong>${escapeHtml(pending.reason?.promptTitle || "Escolha qual influência revelar para descartar.")}</strong>
        <div class="choice-list">
          ${getHiddenCards(player)
            .map(
              (card) => `
                <button data-action="reveal" data-value="${card.id}">
                  ${escapeHtml(roleLabel(card.role))}
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
    `;
  }
  if (pending.type === "discard_revealed" && pending.playerId === me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(`Você revelou ${roleLabel(pending.role)}. Agora descarte essa carta.`)}</strong>
        ${renderShownCard(pending.role, pending.cardId, `Carta revelada: ${roleLabel(pending.role)}`)}
        <div class="choice-list">
          <button data-action="confirm-revealed">Descartar carta</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "exchange" && pending.playerId === me.id) {
    const player = state.players[me.id];
    const pool = [...getHiddenCards(player), ...pending.drawn];
    const needed = pending.keepCount;
    return `
      <div class="prompt">
        <strong>Escolha ${needed} carta${needed > 1 ? "s" : ""} para ficar</strong>
        <div class="choice-list">
          ${pool
            .map((card) => {
              const active = session.exchangeSelection.includes(card.id);
              return `
                <button
                  class="choice-button ${active ? "is-active" : ""}"
                  data-action="toggle-exchange"
                  data-value="${card.id}"
                >
                  ${escapeHtml(roleLabel(card.role))}
                </button>
              `;
            })
            .join("")}
        </div>
        <button ${session.exchangeSelection.length === needed ? "" : "disabled"} data-action="confirm-exchange">Confirmar troca</button>
      </div>
    `;
  }
  if (pending.type === "investigate_pick" && pending.actorId === me.id) {
    const target = state.players[pending.targetId];
    const hidden = target ? getHiddenCards(target) : [];
    return `
      <div class="prompt">
        <strong>Escolha qual influência de ${escapeHtml(target?.name || "alguém")} investigar.</strong>
        <div class="choice-list">
          ${hidden
            .map(
              (card, index) => `
                <button data-action="investigate-pick" data-value="${card.id}">
                  Carta ${index + 1}
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
    `;
  }
  if (pending.type === "investigate" && pending.actorId === me.id) {
    const target = state.players[pending.targetId];
    const card = target?.hand.find((entry) => entry.id === pending.cardId);
    return `
      <div class="prompt">
        <strong>Você viu ${escapeHtml(roleLabel(card?.role || "uma carta"))} de ${escapeHtml(target?.name || "alguém")}.</strong>
        <div class="choice-list">
          <button class="secondary" data-action="investigate-keep">Não forçar troca</button>
          <button data-action="investigate-force">Obrigar troca</button>
        </div>
      </div>
    `;
  }
  return "";
}

function renderPendingNotice(state, me) {
  const pending = state.pending;
  if (!pending) return "";
  if (pending.type === "claim_proof" && pending.playerId !== me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(`${playerLabel(state, pending.playerId)} precisa mostrar ${roleLabel(pending.role)}.`)}</strong>
      </div>
    `;
  }
  if (pending.type === "claim_replace" && pending.playerId !== me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(`${playerLabel(state, pending.playerId)} mostrou ${roleLabel(pending.role)} e vai comprar uma carta nova.`)}</strong>
        ${renderShownCard(pending.role, pending.cardId, `Carta mostrada por ${playerLabel(state, pending.playerId)}`)}
      </div>
    `;
  }
  if (pending.type === "reveal" && pending.playerId !== me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(pending.reason?.bannerText || `${playerLabel(state, pending.playerId)} precisa revelar 1 influência.`)}</strong>
      </div>
    `;
  }
  if (pending.type === "discard_revealed" && pending.playerId !== me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(`${playerLabel(state, pending.playerId)} revelou ${roleLabel(pending.role)} e vai descartar essa carta.`)}</strong>
        ${renderShownCard(pending.role, pending.cardId, `Carta revelada por ${playerLabel(state, pending.playerId)}`)}
      </div>
    `;
  }
  if (pending.type === "investigate_pick" && pending.actorId !== me.id) {
    return `
      <div class="prompt">
        <strong>${escapeHtml(`${playerLabel(state, pending.actorId)} está escolhendo qual carta de ${playerLabel(state, pending.targetId)} investigar.`)}</strong>
      </div>
    `;
  }
  return "";
}

function renderShownCard(role, cardId, alt) {
  const info = ROLE_INFO[role];
  if (!info) return "";
  const assetSrc = cardAsset(role, cardId);
  const idAttr = typeof cardId === "number" ? cardId : "";
  return `
    <div class="reveal-stage">
      <div class="cards cards--center">
        <div class="card" data-action="open-card" data-role="${escapeHtml(role)}" data-card-id="${idAttr}">
          <img src="${assetSrc}" alt="${escapeHtml(alt || info.label)}" />
          <div class="card__tag">${escapeHtml(info.label)}</div>
        </div>
      </div>
    </div>
  `;
}

function onDocumentSubmit(event) {
  if (event.target.id !== "join-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  const name = sanitizeName(form.get("name"));
  if (!name) return;
  session.nameDraft = name;
  sessionStorage.setItem(STORAGE_NAME, name);
  session.joined = true;
  session.joinSubmitted = true;
  ensureHeartbeat();
  postJoin();
}

function onDocumentClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const value = button.dataset.value || "";

  if (action === "open-help") {
    session.helpOpen = true;
    return;
  }
  if (action === "close-help") {
    session.helpOpen = false;
    return;
  }
  if (action === "open-card") {
    const role = button.dataset.role;
    const cardId = Number(button.dataset.cardId);
    if (!role) return;
    session.cardModal = { role, cardId: Number.isFinite(cardId) ? cardId : null };
    return;
  }
  if (action === "close-card") {
    session.cardModal = null;
    return;
  }
  if (action === "retry-join") {
    postJoin();
    return;
  }
  if (action === "toggle-own-cards") {
    session.revealOwnCards = !session.revealOwnCards;
    return;
  }
  if (action === "forfeit") {
    if (!window.confirm("Tem certeza que quer desistir da rodada?")) return;
    game.post({ $: "forfeit", playerId: session.playerId });
    return;
  }
  if (action === "toggle-ready") {
    const me = session.currentState.players[session.playerId];
    if (!me) return;
    game.post({ $: "ready", playerId: session.playerId, ready: me.ready ? 0 : 1 });
    return;
  }
  if (action === "pick-action") {
    session.selectedAction = value;
    session.selectedTargetId = "";
    return;
  }
  if (action === "pick-target") {
    session.selectedTargetId = value;
    return;
  }
  if (action === "send-action") {
    if (!session.selectedAction) return;
    const info = ACTION_INFO[session.selectedAction];
    if (info?.needsTarget && !session.selectedTargetId) return;
    game.post({
      $: "action",
      playerId: session.playerId,
      action: session.selectedAction,
      targetId: info?.needsTarget ? session.selectedTargetId : "",
    });
    session.selectedAction = "";
    session.selectedTargetId = "";
    return;
  }
  if (action === "challenge") {
    game.post({ $: "challenge", playerId: session.playerId });
    return;
  }
  if (action === "pass") {
    game.post({ $: "pass", playerId: session.playerId });
    return;
  }
  if (action === "show-claimed-role") {
    game.post({ $: "show_claimed_role", playerId: session.playerId });
    return;
  }
  if (action === "confirm-revealed") {
    game.post({ $: "confirm_revealed", playerId: session.playerId });
    return;
  }
  if (action === "investigate-pick") {
    const cardId = Number(value);
    if (!Number.isFinite(cardId)) return;
    game.post({ $: "investigate_pick", playerId: session.playerId, cardId });
    return;
  }
  if (action === "investigate-keep") {
    game.post({ $: "investigate_decision", playerId: session.playerId, force: 0 });
    return;
  }
  if (action === "investigate-force") {
    game.post({ $: "investigate_decision", playerId: session.playerId, force: 1 });
    return;
  }
  if (action === "block") {
    game.post({ $: "block", playerId: session.playerId, role: value });
    return;
  }
  if (action === "reveal") {
    game.post({ $: "reveal", playerId: session.playerId, cardId: Number(value) });
    return;
  }
  if (action === "toggle-exchange") {
    const cardId = Number(value);
    const keepCount = session.currentState.pending?.type === "exchange" ? session.currentState.pending.keepCount : 2;
    if (session.exchangeSelection.includes(cardId)) {
      session.exchangeSelection = session.exchangeSelection.filter((id) => id !== cardId);
      return;
    }
    if (session.exchangeSelection.length >= keepCount) {
      session.exchangeSelection = keepCount === 1 ? [cardId] : [session.exchangeSelection[1], cardId];
      return;
    }
    session.exchangeSelection = [...session.exchangeSelection, cardId];
    return;
  }
  if (action === "confirm-exchange") {
    const keepCount = session.currentState.pending?.type === "exchange" ? session.currentState.pending.keepCount : 2;
    if (session.exchangeSelection.length !== keepCount) return;
    game.post({
      $: "exchange",
      playerId: session.playerId,
      keepA: session.exchangeSelection[0],
      keepB: keepCount === 2 ? session.exchangeSelection[1] : 0,
    });
    session.exchangeSelection = [];
  }
}

function onDocumentInput(event) {
  if (event.target.name === "name") {
    session.nameDraft = event.target.value;
    sessionStorage.setItem(STORAGE_NAME, session.nameDraft);
  }
}

function ensureHeartbeat() {
  if (session.heartbeatTimer) return;
  session.heartbeatTimer = window.setInterval(() => {
    if (!session.joined) return;
    sendHeartbeat();
  }, HEARTBEAT_MS);
}

function postJoin() {
  if (!session.syncReady || !session.nameDraft) return;
  game.post({
    $: "join",
    playerId: session.playerId,
    name: sanitizeName(session.nameDraft),
  });
}

function sendHeartbeat() {
  if (!session.syncReady || !session.nameDraft) return;
  game.post({
    $: "heartbeat",
    playerId: session.playerId,
    name: sanitizeName(session.nameDraft),
  });
}

function postSeed() {
  if (!session.syncReady || !session.seedDraft) return;
  const state = session.currentState;
  if (getHostPlayerId(state) !== session.playerId) return;
  game.post({
    $: "set_seed",
    playerId: session.playerId,
    seed: session.seedDraft,
  });
  session.seedPosted = session.seedDraft;
}

function syncHostSeed(state) {
  if (!session.joined || !session.syncReady) return;
  const me = state.players[session.playerId];
  if (!me) return;
  if ((state.phase !== "lobby" && state.phase !== "game_over") || getHostPlayerId(state) !== session.playerId) return;
  if (!session.seedDraft) {
    session.seedDraft = makeSeed();
    sessionStorage.setItem(STORAGE_SEED, session.seedDraft);
  }
  if (state.seed !== session.seedDraft && session.seedPosted !== session.seedDraft) {
    postSeed();
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
