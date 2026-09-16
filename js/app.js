// =====================================================
// App-bootstrap: state laden, schermen wisselen, de "Genereer opstelling"
// knop, en de handmatige wissel-interactie (bank <-> veld) met live
// herberekening van de eerlijkheid.
// =====================================================

(function () {
  const state = loadState();
  let swapPick = null; // { block, name, pos } - pos is null voor een bankspeler, anders de positie-sleutel

  function persistAndRerenderTeam() {
    saveState(state);
    renderTeamScreen(state, persistAndRerenderTeam);
  }

  function switchTab(tab) {
    const isTeam = tab === "team";
    document.getElementById("screen-team").classList.toggle("is-active", isTeam);
    document.getElementById("screen-results").classList.toggle("is-active", !isTeam);
    document.getElementById("tab-btn-team").classList.toggle("is-active", isTeam);
    document.getElementById("tab-btn-results").classList.toggle("is-active", !isTeam);
    document.getElementById("tab-btn-team").setAttribute("aria-selected", String(isTeam));
    document.getElementById("tab-btn-results").setAttribute("aria-selected", String(!isTeam));
  }

  document.getElementById("tab-btn-team").addEventListener("click", () => switchTab("team"));
  document.getElementById("tab-btn-results").addEventListener("click", () => switchTab("results"));
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });

  document.getElementById("input-bonus0").addEventListener("change", (e) => {
    state.bonus0 = Math.max(0, Math.min(30, Number(e.target.value) || 0));
    e.target.value = state.bonus0;
    saveState(state);
  });
  document.getElementById("input-bonus1").addEventListener("change", (e) => {
    state.bonus1 = Math.max(0, Math.min(30, Number(e.target.value) || 0));
    e.target.value = state.bonus1;
    saveState(state);
  });

  document.getElementById("btn-add-temp").addEventListener("click", () => {
    openAddTempPlayerModal(state, persistAndRerenderTeam);
  });

  function rerenderResultsFromLastResult() {
    const r = state.lastResult;
    if (!r || r.type !== "ok") return;
    const timeline = OpstellingSubs.computeFullTimeline(r.blocks, r.schedule, r.targets, r.mins, r.players, r.manualMomentOverrides);
    renderResults({ ...r, timeline }, swapPick);
    saveState(state);
  }

  function runGenerate() {
    const players = effectivePlayers(state);
    const selectie = getSelectedNames(state);
    swapPick = null;

    if (selectie.length < 10) {
      state.lastResult = null;
      document.getElementById("results-content").innerHTML =
        `<div class="banner banner--error"><strong>Minimaal 10 spelers nodig.</strong> Je hebt er nu ${selectie.length} geselecteerd.</div>`;
      switchTab("results");
      return;
    }

    const trainingCounts = {}, priorityFlags = {}, maxMinutes = {}, availabilityFlags = {};
    for (const p of selectie) {
      const ps = state.players[p];
      trainingCounts[p] = ps.training;
      priorityFlags[p] = ps.priority;
      maxMinutes[p] = ps.maxMinutes;
      availabilityFlags[p] = { first: ps.firstHalf, second: ps.secondHalf };
    }

    const positionsOrder = OpstellingLogic.computeDynamicPositionOrder(selectie, players);

    const shortages = OpstellingLogic.checkStructuralFeasibility(selectie, positionsOrder, availabilityFlags, players);
    const heeftTekort = Object.values(shortages).some((lst) => lst.length > 0);
    if (heeftTekort) {
      state.lastResult = { type: "shortage", shortages };
      renderResults(state.lastResult, null);
      saveState(state);
      switchTab("results");
      return;
    }

    const ctx = {
      PLAYERS: players, positionsOrder, availabilityFlags, maxMinutes,
      failureLog: [], bonus0: state.bonus0, bonus1: state.bonus1,
    };

    const res = OpstellingLogic.chooseBestBlocks(selectie, trainingCounts, priorityFlags, maxMinutes, ctx);

    if (res === null) {
      state.lastResult = { type: "no-schedule" };
      renderResults(state.lastResult, null);
      saveState(state);
      switchTab("results");
      return;
    }

    state.lastResult = {
      type: "ok",
      selectie,
      blocks: res.blocks,
      schedule: res.schedule,
      targets: res.targets,
      mins: res.mins,
      slackUsed: res.slackUsed,
      trainingCounts,
      positionsOrder,
      players, // momentopname van de effectieve profielen t.t.v. genereren
      manualMomentOverrides: {}, // { blokNaam: { "In→Uit": minuut } }
    };
    rerenderResultsFromLastResult();
    switchTab("results");
  }

  document.getElementById("btn-generate").addEventListener("click", runGenerate);

  // ---- Handmatig wisselen: bank<->veld EN veld<->veld, via event-delegation ----
  // swapPick = { block, name, pos } waarbij pos "null" is voor een bankspeler
  // en de exacte positie-sleutel (bv. "cv1") voor een veldspeler. Een geldige
  // wissel heeft minstens één kant met pos !== null (bank<->bank kan niet -
  // dat zijn twee spelers die allebei al niet op het veld staan).
  function handleSwapClick(newPick) {
    const isSamePick = swapPick && swapPick.block === newPick.block && swapPick.name === newPick.name && swapPick.pos === newPick.pos;

    if (isSamePick) {
      swapPick = null;
    } else if (swapPick && swapPick.block === newPick.block && (swapPick.pos !== null || newPick.pos !== null)) {
      const schedule = state.lastResult.schedule[newPick.block];
      if (swapPick.pos !== null) schedule[swapPick.pos] = newPick.name;
      if (newPick.pos !== null) schedule[newPick.pos] = swapPick.name;
      swapPick = null;
    } else {
      swapPick = newPick;
    }
    rerenderResultsFromLastResult();
  }

  document.getElementById("results-content").addEventListener("click", (e) => {
    const shiftBtn = e.target.closest(".wissel-shift");
    if (shiftBtn) {
      const row = shiftBtn.closest(".wissel-row");
      const block = row.dataset.block;
      const key = row.dataset.pairkey;
      const richting = Number(shiftBtn.dataset.dir); // -5 of +5

      const r = state.lastResult;
      const huidigeOverrides = r.manualMomentOverrides[block] || {};
      // Startpunt: een eventuele eerdere override, anders het huidige
      // (automatisch berekende) moment van dit paar.
      let huidigeMinuut = huidigeOverrides[key];
      if (huidigeMinuut === undefined) {
        const timeline = OpstellingSubs.computeFullTimeline(r.blocks, r.schedule, r.targets, r.mins, r.players, r.manualMomentOverrides);
        const momentPlan = timeline.allMomentPlans[block] || {};
        for (const m of Object.keys(momentPlan)) {
          if (momentPlan[m].some((pr) => OpstellingSubs.pairKey(pr[0], pr[1]) === key)) { huidigeMinuut = Number(m); break; }
        }
      }
      if (huidigeMinuut === undefined) return; // paar niet gevonden, niets te verschuiven

      if (!r.manualMomentOverrides[block]) r.manualMomentOverrides[block] = {};
      r.manualMomentOverrides[block][key] = huidigeMinuut + richting;
      rerenderResultsFromLastResult();
      return;
    }

    const benchBtn = e.target.closest('[data-swap-target="bench"]');
    const pitchGroup = e.target.closest('[data-swap-target="pitch"]');

    if (benchBtn) {
      handleSwapClick({ block: benchBtn.dataset.block, name: benchBtn.dataset.player, pos: null });
    } else if (pitchGroup) {
      handleSwapClick({ block: pitchGroup.dataset.block, name: pitchGroup.dataset.player, pos: pitchGroup.dataset.pos });
    }
  });

  renderTeamScreen(state, persistAndRerenderTeam);

  // Als er van een vorige sessie nog een opstelling klaarstond, meteen tonen
  // (handig als de pagina midden in een wedstrijd ververst wordt).
  if (state.lastResult) {
    if (state.lastResult.type === "ok") {
      rerenderResultsFromLastResult();
    } else {
      renderResults(state.lastResult, null);
    }
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("Service worker registratie mislukt:", e));
    });
  }
})();
