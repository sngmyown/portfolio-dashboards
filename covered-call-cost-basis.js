/*
 * Covered Call Dashboard — Cost Basis & Cash Extension
 * Load this file AFTER the dashboard's existing inline script.
 *
 * Adds:
 * - Average purchase price per instrument
 * - Actual account cash (KRW / USD)
 * - Account valuation summary (cost / market value / P&L / return)
 * - Cost-basis summary in monthly report
 *
 * Planned future deposits are NOT treated as assets.
 */

(() => {
  'use strict';

  const oldSnapshotInstrument = snapshotInstrument;
  const oldRenderDashboard = renderDashboard;
  const oldRenderCoveredReport = renderCoveredReport;
  const oldBuildCoveredHoldings = buildCoveredHoldings;

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function signedPct(value) {
    if (!Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  }

  function signedUsd(value) {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${sign}$${Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  function latestEntry() {
    return entries.length ? entries[entries.length - 1] : null;
  }

  function latestAccountMetrics(entry = latestEntry()) {
    if (!entry) {
      return {
        costUsd: 0,
        marketUsd: 0,
        cashUsd: 0,
        accountValueUsd: 0,
        pnlUsd: 0,
        returnPct: null,
        knownCostCount: 0,
        positionCount: 0
      };
    }

    ensureLegacyAssets(entry);
    const fx = getFx(entry);
    const assets = getEntryAssets(entry).filter(asset => num(asset.shares) > 0);

    let costUsd = 0;
    let marketUsd = 0;
    let knownCostCount = 0;

    assets.forEach(asset => {
      const shares = num(asset.shares);
      const avgPrice = num(asset.avgPrice ?? asset.averagePrice);
      const currentPrice = num(asset.price);
      const currencyFx = asset.currency === 'KRW' ? fx : 1;

      marketUsd += shares * currentPrice / currencyFx;
      if (avgPrice > 0) {
        costUsd += shares * avgPrice / currencyFx;
        knownCostCount += 1;
      }
    });

    const cashUsd = num(entry.cashUSD) + num(entry.cashKRW) / fx;
    const accountValueUsd = marketUsd + cashUsd;
    const pnlUsd = marketUsd - costUsd;
    const returnPct = costUsd > 0 ? pnlUsd / costUsd * 100 : null;

    return {
      costUsd,
      marketUsd,
      cashUsd,
      accountValueUsd,
      pnlUsd,
      returnPct,
      knownCostCount,
      positionCount: assets.length
    };
  }

  function injectStyles() {
    if (document.getElementById('covered-cost-basis-style')) return;
    const style = document.createElement('style');
    style.id = 'covered-cost-basis-style';
    style.textContent = `
      .instrument-input-fields { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .account-valuation-grid {
        display:grid;
        grid-template-columns:repeat(4,minmax(0,1fr));
        gap:1px;
        background:var(--border);
        border:1px solid var(--border);
        border-radius:var(--radius);
        overflow:hidden;
        margin-bottom:2rem;
      }
      .account-valuation-card { background:var(--bg-card); padding:1.2rem 1.35rem; }
      .account-valuation-label { font-family:var(--mono); font-size:9px; color:var(--text-3); letter-spacing:.12em; text-transform:uppercase; margin-bottom:.45rem; }
      .account-valuation-value { font-family:var(--mono); font-size:20px; font-weight:700; }
      .account-valuation-sub { font-family:var(--mono); font-size:9px; color:var(--text-3); margin-top:.35rem; line-height:1.5; }
      .account-valuation-note { font-family:var(--mono); font-size:10px; color:var(--text-3); margin:-.7rem 0 1.4rem; line-height:1.6; }
      @media (max-width:900px) {
        .instrument-input-fields { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .account-valuation-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
      }
      @media (max-width:620px) {
        .instrument-input-fields, .account-valuation-grid { grid-template-columns:1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  function injectCashInputs() {
    if (document.getElementById('f-cash-krw')) return;
    const fcf = document.getElementById('f-fcf');
    const group = fcf?.closest('.form-group');
    if (!group) return;

    group.insertAdjacentHTML('afterend', `
      <div class="form-group">
        <label>실제 예수금 / 대기현금 (₩) <span class="label-hint">— 실제 계좌 잔고만 입력</span></label>
        <input type="number" id="f-cash-krw" placeholder="0" min="0" step="1">
      </div>
      <div class="form-group">
        <label>실제 예수금 / 대기현금 ($) <span class="label-hint">— 실제 계좌 잔고만 입력</span></label>
        <input type="number" id="f-cash-usd" placeholder="0.00" min="0" step="0.01">
      </div>
    `);
  }

  function injectValuationSection() {
    if (document.getElementById('account-valuation-grid')) return;
    const dashboard = document.getElementById('tab-dashboard');
    const metrics = dashboard?.querySelector('.metrics-grid');
    if (!metrics) return;

    metrics.insertAdjacentHTML('afterend', `
      <div id="account-valuation-grid" class="account-valuation-grid"></div>
      <div id="account-valuation-note" class="account-valuation-note"></div>
    `);
  }

  snapshotInstrument = function patchedSnapshotInstrument(inst, data = {}) {
    const base = oldSnapshotInstrument(inst, data);
    const sourceAvg = data.avgPrice ?? data.averagePrice ?? 0;
    return {
      ...base,
      avgPrice: num(sourceAvg)
    };
  };

  function migrateCostBasisFields() {
    let changed = false;

    entries.forEach(entry => {
      ensureLegacyAssets(entry);
      Object.values(entry.assets || {}).forEach(asset => {
        if (!Object.prototype.hasOwnProperty.call(asset, 'avgPrice')) {
          asset.avgPrice = 0;
          changed = true;
        }
      });

      if (!Object.prototype.hasOwnProperty.call(entry, 'cashKRW')) {
        entry.cashKRW = 0;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(entry, 'cashUSD')) {
        entry.cashUSD = 0;
        changed = true;
      }
    });

    if (changed) save();
  }

  renderInstrumentInputs = function patchedRenderInstrumentInputs(entry = null) {
    const root = document.getElementById('instrument-input-grid');
    if (!root) return;

    const active = activeCoveredInstruments();
    if (!active.length) {
      root.innerHTML = '<div class="empty-state" style="grid-column:1/-1;padding:1.5rem;">먼저 배당 종목을 추가해주세요.</div>';
      return;
    }

    root.innerHTML = active.map(inst => {
      const asset = getEntryAsset(entry, inst.id);
      const step = inst.currency === 'KRW' ? '1' : '0.01';
      const avgPrice = num(asset?.avgPrice ?? asset?.averagePrice);

      return `<div class="instrument-input-card">
        <div class="instrument-input-head">
          <div>
            <div class="instrument-input-title" style="color:${inst.color}">${escapeHtmlCc(inst.ticker)}</div>
            ${inst.name ? `<div style="font-family:var(--mono);font-size:9px;color:var(--text-3);">${escapeHtmlCc(inst.name)}</div>` : ''}
          </div>
          <span class="instrument-input-currency">${inst.currency}</span>
        </div>
        <div class="instrument-input-fields">
          <div><label>보유 주수</label><input type="number" id="asset-${inst.id}-shares" value="${asset ? num(asset.shares) : ''}" placeholder="0" step="0.0001"></div>
          <div><label>평균 매수가 (${currencyPrefix(inst.currency)})</label><input type="number" id="asset-${inst.id}-avg-price" value="${avgPrice > 0 ? avgPrice : ''}" placeholder="0" step="${step}"></div>
          <div><label>월말 주가 (${currencyPrefix(inst.currency)})</label><input type="number" id="asset-${inst.id}-price" value="${asset && num(asset.price) > 0 ? num(asset.price) : ''}" placeholder="0" step="${step}"></div>
          <div><label>수령 배당 (${currencyPrefix(inst.currency)})</label><input type="number" id="asset-${inst.id}-dividend" value="${asset && num(asset.dividend) > 0 ? num(asset.dividend) : ''}" placeholder="0" step="${step}"></div>
        </div>
      </div>`;
    }).join('');
  };

  loadCoveredMonthForm = function patchedLoadCoveredMonthForm() {
    const month = String(document.getElementById('f-month')?.value || '').trim();
    const entry = entries.find(item => item.month === month) || null;
    const prior = !entry && month
      ? entries.filter(item => String(item.month || '') < month).slice().sort((a, b) => String(a.month).localeCompare(String(b.month))).pop() || null
      : null;

    if (entry) {
      document.getElementById('f-fx').value = entry.fxRate || '';
      document.getElementById('f-fcf').value = entry.fcf || '';
      document.getElementById('f-cash-krw').value = num(entry.cashKRW) || '';
      document.getElementById('f-cash-usd').value = num(entry.cashUSD) || '';
      renderInstrumentInputs(entry);
      return;
    }

    document.getElementById('f-fx').value = prior?.fxRate || '';
    document.getElementById('f-fcf').value = '';
    document.getElementById('f-cash-krw').value = prior ? (num(prior.cashKRW) || '') : '';
    document.getElementById('f-cash-usd').value = prior ? (num(prior.cashUSD) || '') : '';

    if (!prior) {
      renderInstrumentInputs();
      return;
    }

    ensureLegacyAssets(prior);
    const carry = { month, assets: {}, fxRate: prior.fxRate, cashKRW: prior.cashKRW, cashUSD: prior.cashUSD };
    activeCoveredInstruments().forEach(inst => {
      const old = getEntryAsset(prior, inst.id);
      if (!old) return;
      carry.assets[inst.id] = snapshotInstrument(inst, {
        shares: old.shares,
        avgPrice: old.avgPrice,
        price: 0,
        dividend: 0
      });
    });
    renderInstrumentInputs(carry);
  };

  addEntry = function patchedAddEntry() {
    const month = String(document.getElementById('f-month')?.value || '').trim();
    if (!month) {
      toast('월을 입력해주세요');
      return;
    }

    const idx = entries.findIndex(entry => entry.month === month);
    const existing = idx >= 0 ? ensureLegacyAssets(entries[idx]) : { month, assets: {} };
    const prior = idx < 0
      ? entries.filter(item => String(item.month || '') < month).slice().sort((a, b) => String(a.month).localeCompare(String(b.month))).pop() || null
      : null;
    if (prior) ensureLegacyAssets(prior);
    const entry = { ...existing, month, assets: { ...(existing.assets || {}) } };

    const fxRaw = document.getElementById('f-fx')?.value ?? '';
    const fcfRaw = document.getElementById('f-fcf')?.value ?? '';
    const cashKrwRaw = document.getElementById('f-cash-krw')?.value ?? '';
    const cashUsdRaw = document.getElementById('f-cash-usd')?.value ?? '';

    entry.fxRate = fxRaw !== '' ? fxRaw : (existing.fxRate || 1300);
    entry.fcf = fcfRaw !== '' ? fcfRaw : (existing.fcf || 0);
    entry.cashKRW = cashKrwRaw !== '' ? num(cashKrwRaw) : num(existing.cashKRW);
    entry.cashUSD = cashUsdRaw !== '' ? num(cashUsdRaw) : num(existing.cashUSD);
    entry.updatedAt = new Date().toISOString();

    activeCoveredInstruments().forEach(inst => {
      const priorAsset = prior ? getEntryAsset(prior, inst.id) : null;
      const old = entry.assets[inst.id] || priorAsset || snapshotInstrument(inst, {});
      const sharesRaw = document.getElementById(`asset-${inst.id}-shares`)?.value ?? '';
      const avgRaw = document.getElementById(`asset-${inst.id}-avg-price`)?.value ?? '';
      const priceRaw = document.getElementById(`asset-${inst.id}-price`)?.value ?? '';
      const dividendRaw = document.getElementById(`asset-${inst.id}-dividend`)?.value ?? '';

      entry.assets[inst.id] = snapshotInstrument(inst, {
        shares: sharesRaw !== '' ? sharesRaw : old.shares,
        avgPrice: avgRaw !== '' ? avgRaw : old.avgPrice,
        price: priceRaw !== '' ? priceRaw : (idx >= 0 ? old.price : 0),
        dividend: dividendRaw !== '' ? dividendRaw : (idx >= 0 ? old.dividend : 0)
      });
    });

    syncLegacyCoveredFields(entry);

    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);

    entries.sort((a, b) => a.month.localeCompare(b.month));
    save();
    renderTable();
    renderDashboard();
    renderCoveredReport();
    toast(`✓ ${month}${idx >= 0 ? ' 데이터 업데이트됨' : ' 데이터 저장됨'}`);

    document.getElementById('f-month').value = '';
    document.getElementById('f-fx').value = '';
    document.getElementById('f-fcf').value = '';
    document.getElementById('f-cash-krw').value = '';
    document.getElementById('f-cash-usd').value = '';
    renderInstrumentInputs();
  };

  buildCoveredHoldings = function patchedBuildCoveredHoldings(entry, previous) {
    const holdings = oldBuildCoveredHoldings(entry, previous);
    holdings.forEach(holding => {
      const asset = getEntryAsset(entry, holding.id);
      const avgPrice = num(asset?.avgPrice ?? asset?.averagePrice);
      const costNative = holding.shares * avgPrice;
      const pnlNative = avgPrice > 0 ? holding.marketNative - costNative : null;

      holding.avgPrice = avgPrice;
      holding.costNative = costNative;
      holding.pnlNative = pnlNative;
      holding.returnPct = avgPrice > 0 && costNative > 0 ? pnlNative / costNative * 100 : null;
    });
    return holdings;
  };

  function renderAccountValuation() {
    injectValuationSection();
    const grid = document.getElementById('account-valuation-grid');
    const note = document.getElementById('account-valuation-note');
    if (!grid || !note) return;

    const entry = latestEntry();
    const metrics = latestAccountMetrics(entry);

    if (!entry || (metrics.positionCount === 0 && metrics.cashUsd === 0)) {
      grid.innerHTML = `
        <div class="account-valuation-card" style="grid-column:1/-1;">
          <div class="account-valuation-label">ACCOUNT VALUATION</div>
          <div class="account-valuation-value">아직 실제 자금 미투입</div>
          <div class="account-valuation-sub">실제 입금·매수 전에는 0원 상태를 유지합니다.</div>
        </div>`;
      note.textContent = '9월·10월 예정 입금은 계획일 뿐 현재 자산으로 계산하지 않습니다.';
      return;
    }

    const fx = getFx(entry);
    const valueKrw = metrics.accountValueUsd * fx;
    const costKrw = metrics.costUsd * fx;
    const pnlKrw = metrics.pnlUsd * fx;
    const missingCost = metrics.positionCount > metrics.knownCostCount;

    grid.innerHTML = `
      <div class="account-valuation-card">
        <div class="account-valuation-label">ACCOUNT VALUE</div>
        <div class="account-valuation-value">${fmtKRW(valueKrw)}</div>
        <div class="account-valuation-sub">${fmt(metrics.accountValueUsd)} USD 환산</div>
      </div>
      <div class="account-valuation-card">
        <div class="account-valuation-label">POSITION COST BASIS</div>
        <div class="account-valuation-value">${metrics.costUsd > 0 ? fmtKRW(costKrw) : '—'}</div>
        <div class="account-valuation-sub">평균매수가 × 보유주수</div>
      </div>
      <div class="account-valuation-card">
        <div class="account-valuation-label">UNREALIZED P&L</div>
        <div class="account-valuation-value" style="color:${metrics.pnlUsd >= 0 ? 'var(--cyan)' : 'var(--red)'}">${metrics.costUsd > 0 ? signedUsd(metrics.pnlUsd) : '—'}</div>
        <div class="account-valuation-sub">${metrics.costUsd > 0 ? fmtKRW(pnlKrw) : '평균매수가 필요'}</div>
      </div>
      <div class="account-valuation-card">
        <div class="account-valuation-label">RETURN</div>
        <div class="account-valuation-value" style="color:${(metrics.returnPct ?? 0) >= 0 ? 'var(--cyan)' : 'var(--red)'}">${signedPct(metrics.returnPct)}</div>
        <div class="account-valuation-sub">실제 예수금 ${fmt(metrics.cashUsd)} 별도</div>
      </div>`;

    note.textContent = missingCost
      ? '일부 보유종목의 평균매수가가 비어 있어 손익은 원가가 입력된 종목만 기준으로 계산됩니다.'
      : '예정 입금액은 포함하지 않습니다. 실제 입금 후 남아 있는 예수금만 월별 데이터에 입력하세요.';
  }

  renderDashboard = function patchedRenderDashboard() {
    oldRenderDashboard();
    renderAccountValuation();
  };

  function prependReportCostSummary() {
    const root = document.getElementById('cc-report-root');
    const month = document.getElementById('cc-report-month')?.value;
    const entry = month ? entries.find(item => item.month === month) : latestEntry();
    if (!root || !entry || !root.children.length) return;

    const metrics = latestAccountMetrics(entry);
    if (!metrics.positionCount && !metrics.cashUsd) return;

    const fx = getFx(entry);
    const block = document.createElement('div');
    block.className = 'report-summary-grid';
    block.style.marginTop = '0';
    block.innerHTML = `
      <div class="report-summary-card"><div class="report-summary-label">계좌 평가액</div><div class="report-summary-value">${fmtKRW(metrics.accountValueUsd * fx)}</div></div>
      <div class="report-summary-card"><div class="report-summary-label">포지션 원가</div><div class="report-summary-value">${metrics.costUsd > 0 ? fmtKRW(metrics.costUsd * fx) : '—'}</div></div>
      <div class="report-summary-card"><div class="report-summary-label">평가손익</div><div class="report-summary-value" style="color:${metrics.pnlUsd >= 0 ? 'var(--cyan)' : 'var(--red)'}">${metrics.costUsd > 0 ? fmtKRW(metrics.pnlUsd * fx) : '—'}</div></div>
      <div class="report-summary-card"><div class="report-summary-label">수익률</div><div class="report-summary-value" style="color:${(metrics.returnPct ?? 0) >= 0 ? 'var(--cyan)' : 'var(--red)'}">${signedPct(metrics.returnPct)}</div></div>`;
    root.prepend(block);
  }

  renderCoveredReport = function patchedRenderCoveredReport() {
    oldRenderCoveredReport();
    prependReportCostSummary();
  };

  injectStyles();
  injectCashInputs();
  injectValuationSection();
  migrateCostBasisFields();
  renderInstrumentInputs();
  renderDashboard();
  renderCoveredReport();
})();
