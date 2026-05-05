import { VibiNet } from "./vendor/vibinet.mjs";

const ROOM = "coup";
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
  duke: { label: "Duque", asset: "./assets/duque.jpeg" },
  assassin: { label: "Axxaxino", asset: "./assets/axxaxino.jpeg" },
  captain: { label: "Captao", asset: "./assets/captao.jpeg" },
  ambassador: { label: "Embaixador", asset: "./assets/embaixador.jpeg" },
  contessa: { label: "Condexxa", asset: "./assets/condexxa.jpeg" },
  inquisitor: { label: "Inquisidor", asset: "./assets/Inquisidor.jpeg" },
};

const ACTION_INFO = {
  income: { label: "Renda", text: "+1 moeda" },
  foreign_aid: { label: "Ajuda externa", text: "+2 moedas" },
  tax: { label: "Imposto", text: "Duque: +3 moedas", role: "duke" },
  steal: { label: "Roubar", text: "Captao: pega 2", role: "captain", needsTarget: true },
  assassinate: { label: "Axxaxinar", text: "Axxaxino: custa 3", role: "assassin", needsTarget: true, cost: 3 },
  exchange: { label: "Trocar", text: "Embaixador: compra 2", role: "ambassador" },
  coup: { label: "Golpe", text: "Custa 7 moedas", needsTarget: true, cost: 7 },
};

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
    exchange: {
      $: "Struct",
      fields: {
        playerId: { $: "String" },
        keepA: { $: "Nat" },
        keepB: { $: "Nat" },
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
  log: ["Sala coup pronta."],
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
    case "exchange":
      return handleExchange(state, post.playerId, post.keepA, post.keepB);
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
    return pushLog(next, `${actor.name} declarou ${info.label.toLowerCase()}.`);
  }
  return beginBlockOrResolve(pushLog(next, `${actor.name} usou ${info.label.toLowerCase()}.`), ctx);
}

function handleChallenge(state, playerId) {
  if (state.phase !== "in_game" || !state.pending) return state;
  const player = state.players[playerId];
  if (!player || !player.connected || !player.inMatch || getHiddenCards(player).length === 0) return state;
  if (state.pending.type === "challenge_action") {
    if (!state.pending.eligibleIds.includes(playerId)) return state;
    return resolveActionChallenge(state, playerId);
  }
  if (state.pending.type === "challenge_block") {
    if (!state.pending.eligibleIds.includes(playerId)) return state;
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
  return pushLog(next, `${blocker.name} bloqueou com ${roleLabel(role)}.`);
}

function handleReveal(state, playerId, cardId) {
  if (!state.pending || state.pending.type !== "reveal" || state.pending.playerId !== playerId) return state;
  return applyRevealChoice(state, playerId, cardId, state.pending.reason, state.pending.continuation);
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
  if (state.pending.type === "reveal") {
    const player = state.players[state.pending.playerId];
    if (!player) return { ...state, pending: null };
    const hidden = getHiddenCards(player);
    if (hidden.length <= 1 || !player.connected) {
      return applyRevealChoice(state, player.id, hidden[0]?.id, state.pending.reason, state.pending.continuation);
    }
  }
  if (state.pending.type === "exchange") {
    const player = state.players[state.pending.playerId];
    if (!player) return { ...state, pending: null };
    if (!player.connected) {
      const pool = [...player.hand, ...state.pending.drawn].map((card) => card.id);
      return handleExchange(state, player.id, pool[0], pool[1]);
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
  if (!actor) return { ...state, pending: null };
  if (playerHasRole(actor, pending.role)) {
    let next = replaceClaimedRole({ ...state, pending: null }, actor.id, pending.role);
    next = pushLog(next, `${actor.name} provou ${roleLabel(pending.role)}.`);
    return beginReveal(next, challengerId, `desafio em ${ACTION_INFO[pending.actionCtx.action].label.toLowerCase()}`, {
      type: "after_claim_proved",
      actionCtx: pending.actionCtx,
    });
  }
  let next = pushLog({ ...state, pending: null }, `${actor.name} blefou.`);
  return beginReveal(next, actor.id, `blefe em ${ACTION_INFO[pending.actionCtx.action].label.toLowerCase()}`, {
    type: "end_turn",
  });
}

function resolveBlockChallenge(state, challengerId) {
  const pending = state.pending;
  if (!pending || pending.type !== "challenge_block") return state;
  const blocker = state.players[pending.blockerId];
  if (!blocker) return { ...state, pending: null };
  if (playerHasRole(blocker, pending.role)) {
    let next = replaceClaimedRole({ ...state, pending: null }, blocker.id, pending.role);
    next = pushLog(next, `${blocker.name} provou ${roleLabel(pending.role)}.`);
    return beginReveal(next, challengerId, `desafio ao bloqueio`, {
      type: "end_turn",
    });
  }
  let next = pushLog({ ...state, pending: null }, `${blocker.name} blefou no bloqueio.`);
  return beginReveal(next, blocker.id, `blefe no bloqueio`, {
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
      return beginReveal(next, target.id, `axxaxinato`, { type: "end_turn" });
    }
    case "exchange": {
      const drawn = state.deck.slice(0, 2);
      const keepCount = getHiddenCards(actor).length;
      const next = {
        ...state,
        deck: state.deck.slice(2),
        pending: {
          type: "exchange",
          playerId: actor.id,
          drawn,
          keepCount,
        },
      };
      return pushLog(next, `${actor.name} comprou 2 cartas.`);
    }
    case "coup": {
      const target = state.players[actionCtx.targetId];
      if (!target || !target.inMatch || getHiddenCards(target).length === 0) return finishTurn(state);
      const next = pushLog(state, `${actor.name} aplicou golpe em ${target.name}.`);
      return beginReveal(next, target.id, `golpe`, { type: "end_turn" });
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
  if (hidden.length === 1 || !player.connected) {
    return applyRevealChoice(state, playerId, hidden[0].id, reason, continuation);
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

function applyRevealChoice(state, playerId, cardId, reason, continuation) {
  const player = state.players[playerId];
  if (!player) return resolveContinuation({ ...state, pending: null }, continuation);
  const hand = player.hand.map((card) => (card.id === cardId ? { ...card, revealed: true } : card));
  const nextPlayer = { ...player, hand };
  let next = withPlayer({ ...state, pending: null }, playerId, nextPlayer);
  const revealed = hand.find((card) => card.id === cardId);
  next = pushLog(next, `${player.name} revelou ${revealed ? roleLabel(revealed.role) : "uma carta"} por ${reason}.`);
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
  const nextPlayer = state.players[nextId];
  const next = {
    ...state,
    pending: null,
    currentPlayerId: nextId,
    turnNumber: state.turnNumber + 1,
  };
  return pushLog(next, `Turno de ${nextPlayer.name}.`);
}

function replaceClaimedRole(state, playerId, role) {
  const player = state.players[playerId];
  if (!player) return state;
  const hand = [...player.hand];
  const index = hand.findIndex((card) => !card.revealed && card.role === role);
  if (index === -1) return state;
  let deck = [...state.deck];
  let rngCounter = state.rngCounter;
  const returned = { ...hand[index], revealed: false };
  const inserted = insertAtRandom(deck, returned, state.seed, rngCounter);
  deck = inserted.deck;
  rngCounter = inserted.rngCounter;
  const replacement = deck[0];
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
  const log = [...state.log, message].slice(-14);
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
  const roles = ["duke", "assassin", "captain", "ambassador", "contessa"];
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
  if (action === "steal") return ["captain", "ambassador"];
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
        <div class="topbar__title">
          <p class="eyebrow">Sala fixa</p>
          <h1 class="title">coup</h1>
        </div>
        <div class="pill ${state.phase === "in_game" ? "good" : ""}">${phaseText(state)}</div>
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
          ${
            playerId === me.id
              ? `
                <div class="row">
                  <div class="small">${state.phase === "game_over" && state.winnerId ? `${escapeHtml(playerLabel(state, state.winnerId))} venceu.` : ""}</div>
                  <button class="${me.ready ? "secondary" : ""}" data-action="toggle-ready">
                    ${me.ready ? "Cancelar pronto" : state.phase === "game_over" ? "Pronto p/ replay" : "Ficar pronto"}
                  </button>
                </div>
              `
              : ""
          }
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
    </section>
  `;
}

function renderBoard(state, me) {
  const players = state.playerOrder
    .map((playerId) => state.players[playerId])
    .filter((player) => player && player.inMatch)
    .map((player) => renderPlayerCard(player, state, me.id))
    .join("");

  return `
    <section class="panel board">
      <div class="phase-banner">${escapeHtml(getPromptText(state, me.id))}</div>
      <div class="player-grid">${players}</div>
    </section>
    ${renderActionPanel(state, me)}
  `;
}

function renderPlayerCard(player, state, myId) {
  const hiddenCards = getHiddenCards(player);
  const isMe = player.id === myId;
  const cards = player.hand
    .map((card) => {
      const visible = isMe || card.revealed;
      const info = ROLE_INFO[card.role];
      return `
        <div class="card ${visible ? "" : "card--hidden"}">
          ${visible ? `<img src="${info.asset}" alt="${escapeHtml(info.label)}" />` : ""}
          ${visible ? `<div class="card__tag">${escapeHtml(info.label)}</div>` : ""}
        </div>
      `;
    })
    .join("");
  return `
    <article class="player-card ${player.id === state.currentPlayerId ? "is-turn" : ""} ${isMe ? "is-me" : ""} ${
      hiddenCards.length === 0 ? "is-out" : ""
    }">
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
      <div class="cards">${cards}</div>
    </article>
  `;
}

function renderActionPanel(state, me) {
  const actionPrompt = renderActionPrompt(state, me);
  const responsePrompt = renderResponsePrompt(state, me);
  return `
    <section class="panel">
      <div class="section-title">Ações</div>
      ${responsePrompt || actionPrompt || '<div class="empty">Esperando outros jogadores.</div>'}
    </section>
  `;
}

function renderActionPrompt(state, me) {
  if (state.currentPlayerId !== me.id || state.pending) return "";
  const opponents = getAliveConnectedIds(state).filter((playerId) => playerId !== me.id);
  const forceCoup = me.coins >= 10;
  const actions = Object.entries(ACTION_INFO)
    .filter(([key]) => !forceCoup || key === "coup")
    .map(([key, info]) => {
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
          <span>${escapeHtml(info.label)}</span>
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
    const actor = state.players[pending.actionCtx.actorId];
    const info = ACTION_INFO[pending.actionCtx.action];
    return `
      <div class="prompt">
        <strong>${escapeHtml(actor.name)} declarou ${escapeHtml(info.label.toLowerCase())}</strong>
        <div class="choice-list">
          <button data-action="challenge">Desafiar</button>
          <button class="secondary" data-action="pass">Passar</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "block_choice" && pending.eligibleIds.includes(me.id)) {
    const options = getAllowedBlocks(pending.actionCtx.action, pending.actionCtx.targetId);
    return `
      <div class="prompt">
        <strong>Você pode bloquear</strong>
        <div class="choice-list">
          ${options
            .map(
              (role) => `
                <button data-action="block" data-value="${role}">
                  Bloquear com ${escapeHtml(roleLabel(role))}
                </button>
              `,
            )
            .join("")}
          <button class="secondary" data-action="pass">Não bloquear</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "challenge_block" && pending.eligibleIds.includes(me.id)) {
    const blocker = state.players[pending.blockerId];
    return `
      <div class="prompt">
        <strong>${escapeHtml(blocker.name)} bloqueou com ${escapeHtml(roleLabel(pending.role))}</strong>
        <div class="choice-list">
          <button data-action="challenge">Desafiar bloqueio</button>
          <button class="secondary" data-action="pass">Passar</button>
        </div>
      </div>
    `;
  }
  if (pending.type === "reveal" && pending.playerId === me.id) {
    const player = state.players[me.id];
    return `
      <div class="prompt">
        <strong>Escolha qual influência revelar</strong>
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
  return "";
}

function phaseText(state) {
  if (state.phase === "lobby") return "lobby";
  if (state.phase === "in_game") return "jogo";
  if (state.phase === "game_over") return "fim";
  return state.phase;
}

function getPromptText(state, myId) {
  if (state.phase !== "in_game") return "Esperando a rodada começar.";
  if (state.pending?.type === "reveal") {
    return `${playerLabel(state, state.pending.playerId)} precisa revelar uma influência.`;
  }
  if (state.pending?.type === "exchange") {
    return `${playerLabel(state, state.pending.playerId)} está escolhendo cartas.`;
  }
  if (state.pending?.type === "challenge_action") {
    const actor = playerLabel(state, state.pending.actionCtx.actorId);
    return `${actor} declarou ${ACTION_INFO[state.pending.actionCtx.action].label.toLowerCase()}.`;
  }
  if (state.pending?.type === "block_choice") {
    return `Janela de bloqueio aberta.`;
  }
  if (state.pending?.type === "challenge_block") {
    return `Janela de desafio ao bloqueio.`;
  }
  if (state.currentPlayerId === myId) return "Seu turno.";
  return `Turno de ${playerLabel(state, state.currentPlayerId)}.`;
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
  if (action === "retry-join") {
    postJoin();
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
