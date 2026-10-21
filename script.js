/**
 * Google Apps Script Web App URL
 * README.md 안내대로 배포한 뒤 받은 URL을 넣으세요.
 * 넣지 않으면 데모 모드(이 브라우저에만 저장)로 동작합니다.
 */
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyH6Nlu4rp_ebMoCJ_BNjWScGhAIY2O42P4SJBCbgW4SdDJdnFG3TmOEuHZMC3CzABQ/exec';

const DEMO_MODE = SCRIPT_URL.startsWith('YOUR_');

/* =========================================================
 * 데이터 API (구글 시트 / 데모)
 * ========================================================= */
const api = DEMO_MODE ? createDemoApi() : createSheetApi();

function createSheetApi() {
    async function get(action) {
        const res = await fetch(`${SCRIPT_URL}?action=${action}`);
        const result = await res.json();
        if (result.status !== 'success') throw new Error(result.message || '불러오기 실패');
        return result.data;
    }

    // text/plain → preflight 없는 단순 요청이라 응답을 읽을 수 있음
    async function post(body) {
        const res = await fetch(SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(body)
        });
        // 저장은 끝났는데 Google 쪽 응답 페이지가 가끔 HTML 오류로 오는 경우가 있어,
        // JSON이 아니면 성공으로 봅니다. (서버 처리 후에만 응답이 오기 때문)
        let result;
        try {
            result = JSON.parse(await res.text());
        } catch {
            return null;
        }
        if (result.status !== 'success') throw new Error(result.message || '저장 실패');
        return result.data;
    }

    return {
        getMaster: () => get('master'),
        getRecords: () => get('records'),
        getLines: () => get('lines'),
        addRecord: (record) => post({ action: 'addRecord', ...record }),
        updateRecord: (id, fields) => post({ action: 'updateRecord', id, ...fields }),
        deleteRecord: (id) => post({ action: 'deleteRecord', id }),
        addMaster: (item) => post({ action: 'addMaster', ...item })
    };
}

function createDemoApi() {
    const MASTER_KEY = 'shortage_demo_master';
    const RECORD_KEY = 'shortage_demo_records';
    const SAMPLE_MASTER = {
        parts: {
            'A1001-0001': { partName: '볼트 M6x20', vendor: '대성볼트' },
            'A1001-0002': { partName: '너트 M6', vendor: '대성볼트' },
            'B2002-0101': { partName: 'PCB 메인보드', vendor: '한빛전자' }
        },
        vendors: { '대성볼트': '김민수', '한빛전자': '이지은' }
    };

    const load = (key, fallback) => {
        try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
    };
    const save = (key, value) => {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 시 무시 */ }
    };

    return {
        getMaster: async () => load(MASTER_KEY, SAMPLE_MASTER),
        getRecords: async () => load(RECORD_KEY, []),
        getLines: async () => ['1라인', '2라인', 'OA'],
        addRecord: async (record) => {
            const records = load(RECORD_KEY, []);
            const saved = { ...record, id: String(Date.now()), createdAt: formatDateTime(new Date()) };
            records.unshift(saved);
            save(RECORD_KEY, records);
            return saved;
        },
        updateRecord: async (id, fields) => {
            const records = load(RECORD_KEY, []);
            Object.assign(records.find((r) => r.id === id) || {}, fields);
            save(RECORD_KEY, records);
        },
        deleteRecord: async (id) => {
            save(RECORD_KEY, load(RECORD_KEY, []).filter((r) => r.id !== id));
        },
        addMaster: async (item) => {
            const master = load(MASTER_KEY, SAMPLE_MASTER);
            master.parts[item.partNo] = { partName: item.partName, vendor: item.vendor };
            if (!master.vendors[item.vendor]) master.vendors[item.vendor] = item.manager;
            save(MASTER_KEY, master);
        }
    };
}

function formatDateTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* =========================================================
 * 화면
 * ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);

    let master = { parts: {}, vendors: {} };
    let records = [];
    let pendingRecord = null;
    let pendingDeleteId = null;

    // 연속 등록 시 다시 입력하지 않도록 기기에 기억해 두는 항목
    // (사용라인은 선택 목록이라 목록을 받은 뒤에 다시 맞춤 → restoreLine)
    const REMEMBER = { writer: 'shortage_writer', line: 'shortage_line' };

    if (DEMO_MODE) $('demoBanner').classList.remove('hidden');

    function remembered(key) {
        try { return localStorage.getItem(key) || ''; } catch { return ''; }
    }

    function restoreRemembered() {
        $('writer').value = remembered(REMEMBER.writer);
        restoreLine();
    }

    function saveRemembered(record) {
        Object.entries(REMEMBER).forEach(([id, key]) => {
            try { localStorage.setItem(key, record[id]); } catch { /* 저장 불가 시 무시 */ }
        });
    }

    /* ---------- 사용라인 (구글 시트 '라인명' 시트) ----------
     * 마지막으로 받은 목록을 기기에 저장해 두고 먼저 보여준 뒤, 최신 목록으로 바꿉니다.
     * 목록을 한 번도 못 받았으면(시트 없음/연결 오류) 직접 입력 칸으로 바꿉니다.
     */
    const LINES_CACHE_KEY = 'shortage_lines_cache';
    let lineManualMode = false;

    function lineValue() {
        return (lineManualMode ? $('lineManual') : $('line')).value.trim();
    }

    function restoreLine() {
        const saved = remembered(REMEMBER.line);
        if (lineManualMode) {
            $('lineManual').value = saved;
        } else if ([...$('line').options].some((o) => o.value === saved)) {
            $('line').value = saved;
        }
    }

    function setLineManual(manual) {
        lineManualMode = manual;
        $('line').classList.toggle('hidden', manual);
        $('line').required = !manual;
        $('lineManual').classList.toggle('hidden', !manual);
        $('lineManual').required = manual;
    }

    function applyLines(lines) {
        const current = lineValue();
        $('line').innerHTML = '<option value="" disabled selected>선택</option>' +
            lines.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
        setLineManual(false);
        // 고르던 값이 있으면 유지, 없으면 지난번 선택
        if (current && lines.includes(current)) $('line').value = current;
        else restoreLine();
    }

    async function loadLines() {
        let hasList = false;
        try {
            const cached = JSON.parse(localStorage.getItem(LINES_CACHE_KEY));
            if (Array.isArray(cached) && cached.length) {
                applyLines(cached);
                hasList = true;
            }
        } catch { /* 저장된 목록 없음 */ }

        try {
            const lines = await api.getLines();
            if (!lines.length) throw new Error('EMPTY');
            applyLines(lines);
            try { localStorage.setItem(LINES_CACHE_KEY, JSON.stringify(lines)); } catch { /* 저장 불가 시 무시 */ }
        } catch {
            if (!hasList) {
                setLineManual(true);
                restoreLine();
            }
        }
    }

    restoreRemembered();

    /* ---------- 탭 ---------- */
    function showTab(tab) {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        const isStatus = tab === 'status';
        $('submitSection').classList.toggle('hidden', isStatus);
        $('statusSection').classList.toggle('hidden', !isStatus);
        document.body.classList.toggle('on-status', isStatus);
        $('partSuggest').classList.add('hidden');
        window.scrollTo(0, 0);
        if (isStatus) loadRecords();
    }

    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });

    // 헤더의 전체/대기/완료 건수 → 처리현황 탭에서 해당 상태만 보기
    document.querySelectorAll('.sum-card').forEach((card) => {
        card.addEventListener('click', () => {
            setFilter(card.dataset.filter);
            showTab('status');
        });
    });

    /* ---------- 자재 마스터 ---------- */
    // 품번이 많아 서버에서 받는 데 시간이 걸리므로, 마지막으로 받은 목록을 기기에 저장해 두고
    // 화면을 열면 그것부터 바로 쓰고, 최신 목록은 뒤에서 받아 바꿔 끼웁니다.
    const MASTER_CACHE_KEY = 'shortage_master_cache';
    let masterLoaded = false;

    async function loadMaster() {
        try {
            const cached = JSON.parse(localStorage.getItem(MASTER_CACHE_KEY));
            if (cached && cached.parts) applyMaster(cached);
        } catch { /* 저장된 목록 없음 */ }

        if (!masterLoaded) setLookupMsg('자재 정보를 불러오는 중입니다...', '');
        try {
            const fresh = await api.getMaster();
            applyMaster(fresh);
            try { localStorage.setItem(MASTER_CACHE_KEY, JSON.stringify(fresh)); } catch { /* 저장 불가 시 무시 */ }
        } catch (err) {
            if (!masterLoaded) setLookupMsg('자재 정보를 불러오지 못했습니다: ' + err.message, 'warn');
        }
    }

    /**
     * 자재마스터와 업체담당자 시트의 업체 이름이 조금씩 달라도 같은 업체로 찾음
     *  - 띄어쓰기·대소문자 무시        카마다 코리아 = 카마다코리아
     *  - 앞의 S_ / S- 무시             S_화영테크 = 화영테크
     *  - (주), 주식회사 무시            플로티어(주) = 플로티어
     *  - 표기 차이 통일                 프라스틱=플라스틱, 이엔지=ENG, 앤=엔, 산업 생략
     *  - 그래도 없으면 괄호 안 무시     지구테크 = 지구테크(+동일메탈)
     *    (괄호를 빼면 겹치는 업체, 예: 원진산업(진천)/(부천) 은 이 단계에서 제외)
     */
    function vendorKey(name) {
        return String(name || '')
            .replace(/\s+/g, '')
            .toUpperCase()
            .replace(/^S[_-]/, '')
            .replace(/\(주\)|주식회사/g, '')
            .replace(/프라스틱/g, '플라스틱')
            .replace(/이엔지/g, 'ENG')
            .replace(/앤/g, '엔')
            .replace(/산업/g, '');
    }
    const stripParen = (key) => key.replace(/\(.*?\)/g, '');

    let vendorExact = {};
    let vendorLoose = {};

    function findManager(vendor) {
        const key = vendorKey(vendor);
        if (key in vendorExact) return vendorExact[key];
        const loose = vendorLoose[stripParen(key)];
        return loose === null ? undefined : loose;
    }

    function applyMaster(data) {
        master = data;
        vendorExact = {};
        vendorLoose = {};
        Object.entries(master.vendors).forEach(([v, m]) => {
            const key = vendorKey(v);
            vendorExact[key] = m;
            const loose = stripParen(key);
            vendorLoose[loose] = loose in vendorLoose ? null : m;
        });
        // 처음 받았을 때만 다시 조회 (이후 갱신 때는 입력 중인 내용을 지우지 않음)
        if (!masterLoaded) {
            masterLoaded = true;
            lookup();
        }
        partKeys = Object.keys(master.parts).sort();
        $('vendorList').innerHTML = Object.keys(master.vendors).sort()
            .map((v) => `<option value="${escapeHtml(v)}"></option>`)
            .join('');
    }

    /* ---------- 자동 조회: 품번 → 품명·업체 → 담당자 ---------- */
    const autoFields = [$('partName'), $('vendor'), $('manager')];

    function setLookupMsg(text, type) {
        $('lookupMsg').textContent = text;
        $('lookupMsg').className = 'lookup-msg ' + (type || '');
    }

    function setEditable(el, editable) {
        el.readOnly = !editable;
        el.placeholder = editable ? '직접 입력' : '자동 입력';
    }

    function lookup() {
        const key = $('partNo').value.trim().toUpperCase();
        const part = master.parts[key];

        if (!key || !masterLoaded) {
            autoFields.forEach((el) => { el.value = ''; setEditable(el, false); });
            $('saveMasterWrap').classList.add('hidden');
            setLookupMsg(masterLoaded ? '' : '자재 정보를 불러오는 중입니다...');
            return;
        }

        if (part) {
            $('partName').value = part.partName;
            $('vendor').value = part.vendor;
            setEditable($('partName'), false);
            setEditable($('vendor'), false);
            $('saveMasterWrap').classList.add('hidden');
            setLookupMsg('✔ 자재 정보를 불러왔습니다.', 'ok');
        } else {
            // 마스터에 없는 품번 → 품명·업체 직접 입력
            $('partName').value = '';
            $('vendor').value = '';
            setEditable($('partName'), true);
            setEditable($('vendor'), true);
            $('saveMasterWrap').classList.remove('hidden');
            setLookupMsg('⚠ 등록되지 않은 품번입니다. 품명과 업체를 직접 입력해 주세요.', 'warn');
        }
        lookupManager();
    }

    function lookupManager() {
        const vendor = $('vendor').value.trim();
        const manager = findManager(vendor);

        if (manager !== undefined) {
            $('manager').value = manager;
            setEditable($('manager'), false);
        } else {
            // 업체담당자 시트에 없는 업체 → 담당자 직접 입력
            $('manager').value = '';
            setEditable($('manager'), Boolean(vendor));
            if (vendor && master.parts[$('partNo').value.trim().toUpperCase()]) {
                setLookupMsg(`⚠ [${vendor}] 업체의 담당자가 등록되어 있지 않습니다. 담당자를 직접 입력해 주세요.`, 'warn');
            }
        }

        // 새 품번이거나 담당자 없는 업체면 시트에도 저장할지 선택
        const isNewPart = !master.parts[$('partNo').value.trim().toUpperCase()];
        const isNewVendor = Boolean(vendor) && manager === undefined;
        $('saveMasterWrap').classList.toggle('hidden', !($('partNo').value.trim() && (isNewPart || isNewVendor)));
    }

    /* ---------- 품번 자동완성 ----------
     * 브라우저 기본 목록(datalist)에 품번 수천 개를 넣으면 한 글자마다 전체를 다시 걸러서 느려지므로,
     * 2글자 이상 입력 후 잠깐 멈췄을 때 일치하는 품번 최대 8개만 보여줍니다.
     */
    const SUGGEST_MIN = 2;
    const SUGGEST_MAX = 8;
    let partKeys = [];
    let suggestTimer = null;

    function renderSuggest() {
        const q = $('partNo').value.trim().toUpperCase();
        const box = $('partSuggest');
        // 정확히 일치하면 이미 자동 입력됐으므로 목록을 닫음
        if (q.length < SUGGEST_MIN || master.parts[q]) {
            box.classList.add('hidden');
            return;
        }

        const starts = [];
        const contains = [];
        for (const k of partKeys) {
            if (k.startsWith(q)) starts.push(k);
            else if (k.includes(q)) contains.push(k);
            if (starts.length >= SUGGEST_MAX) break;
        }
        const list = starts.concat(contains).slice(0, SUGGEST_MAX);

        box.innerHTML = list.map((k) => `
            <li data-part="${escapeHtml(k)}">
                <span class="s-no">${escapeHtml(k)}</span>
                <span class="s-name">${escapeHtml(master.parts[k].partName)}</span>
            </li>`).join('');
        box.classList.toggle('hidden', list.length === 0);
    }

    $('partNo').addEventListener('input', () => {
        $('clearPartNo').classList.toggle('hidden', !$('partNo').value);
        lookup();
        clearTimeout(suggestTimer);
        suggestTimer = setTimeout(renderSuggest, 150);
    });

    // 목록 선택 (blur보다 먼저 처리되도록 pointerdown 사용)
    $('partSuggest').addEventListener('pointerdown', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        e.preventDefault();
        $('partNo').value = li.dataset.part;
        $('partSuggest').classList.add('hidden');
        lookup();
    });

    $('partNo').addEventListener('blur', () => $('partSuggest').classList.add('hidden'));
    $('partNo').addEventListener('focus', renderSuggest);
    $('vendor').addEventListener('input', lookupManager);

    $('clearPartNo').addEventListener('click', () => {
        $('partNo').value = '';
        $('clearPartNo').classList.add('hidden');
        lookup();
        $('partNo').focus();
    });

    /* ---------- 필요수량 −/+ ---------- */
    document.querySelectorAll('.step-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = (parseInt($('qty').value, 10) || 0) + Number(btn.dataset.step);
            $('qty').value = Math.max(1, next);
        });
    });

    /* ---------- 등록 ---------- */
    const form = $('shortageForm');

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        hideNotification();

        pendingRecord = {
            // 응답을 못 받았을 때 실제 저장 여부 확인 + 재전송 시 중복 방지용
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            writer: $('writer').value.trim(),
            line: lineValue(),
            partNo: $('partNo').value.trim().toUpperCase(),
            partName: $('partName').value.trim(),
            vendor: $('vendor').value.trim(),
            manager: $('manager').value.trim(),
            qty: $('qty').value,
            status: '대기', // 등록 시 항상 대기, 처리현황 탭에서 완료로 변경
            note: $('note').value.trim()
        };

        const rows = [
            ['작성자', pendingRecord.writer],
            ['사용라인', pendingRecord.line],
            ['자재품번', pendingRecord.partNo],
            ['품명', pendingRecord.partName],
            ['업체', pendingRecord.vendor],
            ['담당자', pendingRecord.manager],
            ['필요수량', `${pendingRecord.qty} EA`],
            ['비고', pendingRecord.note || '-']
        ];
        $('confirmDetails').innerHTML = rows.map(([label, value]) =>
            `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${escapeHtml(value)}</span></div>`
        ).join('');
        $('confirmModal').classList.remove('hidden');
    });

    $('cancelSubmit').addEventListener('click', () => $('confirmModal').classList.add('hidden'));

    $('confirmSubmit').addEventListener('click', async () => {
        $('confirmModal').classList.add('hidden');
        if (!pendingRecord) return;

        const submitBtn = form.querySelector('.submit-btn');
        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').style.display = 'none';
        submitBtn.querySelector('.loader').style.display = 'inline-block';

        try {
            const isNew = !master.parts[pendingRecord.partNo] || findManager(pendingRecord.vendor) === undefined;
            try {
                await api.addRecord(pendingRecord);
            } catch (err) {
                // 응답만 못 받고 실제로는 저장됐을 수 있으니 목록에서 확인
                const saved = await api.getRecords().then((list) => list.some((r) => r.id === pendingRecord.id), () => false);
                if (!saved) throw err;
            }

            if (isNew && $('saveMaster').checked) {
                await api.addMaster(pendingRecord);
                await loadMaster();
            }

            showNotification(`[${pendingRecord.partNo}] 결품이 등록되었습니다.`, 'success');
            saveRemembered(pendingRecord);
            form.reset();
            restoreRemembered();
            $('clearPartNo').classList.add('hidden');
            lookup();
            window.scrollTo(0, 0);
            loadRecords(); // 헤더 건수 갱신
        } catch (err) {
            showNotification('등록 중 오류가 발생했습니다: ' + err.message, 'error');
        } finally {
            pendingRecord = null;
            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').style.display = '';
            submitBtn.querySelector('.loader').style.display = 'none';
        }
    });

    // 화면 아래에 잠깐 보여주고 사라지는 알림 (오류는 조금 더 오래)
    let toastTimer = null;

    function showNotification(message, type) {
        $('notificationMessage').textContent = message;
        $('notification').className = 'toast ' + type;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideNotification, type === 'error' ? 6000 : 2500);
    }

    function hideNotification() {
        $('notification').className = 'toast hidden';
    }

    $('notification').addEventListener('click', hideNotification);

    /* ---------- 처리현황 ---------- */
    // 핸드폰은 카드 목록(recordList), PC는 표(recordsTableBody)를 보여줌 — 둘 다 같은 내용으로 그림
    const listViews = [$('recordList'), $('recordsTableBody')];
    let currentFilter = '';

    async function loadRecords() {
        $('refreshBtn').classList.add('spinning');
        if (!records.length) {
            $('recordList').innerHTML = '<p class="no-records">불러오는 중...</p>';
            $('recordsTableBody').innerHTML = '<tr><td colspan="11">불러오는 중...</td></tr>';
        }
        $('noRecords').classList.add('hidden');
        try {
            records = await api.getRecords();
            renderRecords();
        } catch (err) {
            const msg = `불러오기 실패: ${escapeHtml(err.message)}`;
            $('recordList').innerHTML = `<p class="no-records">${msg}</p>`;
            $('recordsTableBody').innerHTML = `<tr><td colspan="11">${msg}</td></tr>`;
        } finally {
            $('refreshBtn').classList.remove('spinning');
        }
    }

    function setFilter(value) {
        currentFilter = value;
        document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === value));
        renderRecords();
    }

    function filteredRecords() {
        const q = $('search').value.trim().toLowerCase();
        return records.filter((r) => {
            if (currentFilter && r.status !== currentFilter) return false;
            if (!q) return true;
            return [r.partNo, r.partName, r.vendor, r.manager, r.line, r.writer].some((v) => String(v).toLowerCase().includes(q));
        });
    }

    function badgeHtml(r) {
        const done = r.status === '완료';
        return `<button type="button" class="badge ${done ? 'done' : 'wait'}" data-act="toggle" title="눌러서 상태 변경">${escapeHtml(r.status || '대기')}</button>`;
    }

    function cardHtml(r) {
        const done = r.status === '완료';
        return `
            <article class="rec-card ${done ? 'is-done' : ''}" data-id="${escapeHtml(r.id)}">
                <div class="rec-top">
                    <div>
                        <div class="rec-part">${escapeHtml(r.partNo)}</div>
                        <div class="rec-name">${escapeHtml(r.partName)}</div>
                    </div>
                    ${badgeHtml(r)}
                </div>
                <dl class="rec-grid">
                    <div><dt>필요수량</dt><dd class="rec-qty">${escapeHtml(r.qty)} <small>EA</small></dd></div>
                    <div><dt>사용라인</dt><dd>${escapeHtml(r.line)}</dd></div>
                    <div><dt>업체</dt><dd>${escapeHtml(r.vendor)}</dd></div>
                    <div><dt>담당자</dt><dd>${escapeHtml(r.manager) || '-'}</dd></div>
                    <div><dt>작성자</dt><dd>${escapeHtml(r.writer)}</dd></div>
                    <div><dt>등록일시</dt><dd>${escapeHtml(r.createdAt)}</dd></div>
                </dl>
                <div class="rec-bottom">
                    <input class="note-input" value="${escapeHtml(r.note)}" data-act="note" placeholder="비고 입력" enterkeyhint="done">
                    <button type="button" class="del-btn" data-act="delete">삭제</button>
                </div>
            </article>`;
    }

    function rowHtml(r) {
        return `
            <tr data-id="${escapeHtml(r.id)}" class="${r.status === '완료' ? 'is-done' : ''}">
                <td>${escapeHtml(r.createdAt)}</td>
                <td>${escapeHtml(r.writer)}</td>
                <td>${escapeHtml(r.line)}</td>
                <td class="part-no">${escapeHtml(r.partNo)}</td>
                <td class="name-cell">${escapeHtml(r.partName)}</td>
                <td>${escapeHtml(r.vendor)}</td>
                <td>${escapeHtml(r.manager)}</td>
                <td class="qty-cell">${escapeHtml(r.qty)}</td>
                <td>${badgeHtml(r)}</td>
                <td class="note-cell"><input class="note-input" value="${escapeHtml(r.note)}" data-act="note" placeholder="-"></td>
                <td><button type="button" class="del-btn" data-act="delete">삭제</button></td>
            </tr>`;
    }

    function renderRecords() {
        const list = filteredRecords();

        $('recordList').innerHTML = list.map(cardHtml).join('');
        $('recordsTableBody').innerHTML = list.map(rowHtml).join('');

        const waitCount = records.filter((r) => r.status !== '완료').length;
        $('noRecords').classList.toggle('hidden', list.length > 0);
        $('cntAll').textContent = records.length;
        $('cntWait').textContent = waitCount;
        $('cntDone').textContent = records.length - waitCount;
        $('tabWaitBadge').textContent = waitCount > 99 ? '99+' : waitCount;
        $('tabWaitBadge').classList.toggle('hidden', waitCount === 0);
    }

    $('search').addEventListener('input', renderRecords);
    document.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => setFilter(btn.dataset.filter));
    });
    $('refreshBtn').addEventListener('click', loadRecords);

    const recordOf = (el) => {
        const holder = el.closest('[data-id]');
        return holder ? records.find((r) => r.id === holder.dataset.id) : null;
    };

    listViews.forEach((view) => {
        // 상태 변경 / 삭제
        view.addEventListener('click', async (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act !== 'toggle' && act !== 'delete') return;
            const rec = recordOf(e.target);
            if (!rec) return;

            if (act === 'toggle') {
                rec.status = rec.status === '완료' ? '대기' : '완료';
                renderRecords();
                showNotification(`[${rec.partNo}] ${rec.status}(으)로 변경했습니다.`, 'success');
                try {
                    await api.updateRecord(rec.id, { status: rec.status });
                } catch (err) {
                    showNotification('상태 변경 응답을 받지 못했습니다. 목록을 다시 불러옵니다.', 'error');
                    loadRecords();
                }
            } else {
                pendingDeleteId = rec.id;
                $('deleteDescription').innerHTML = `[${escapeHtml(rec.partNo)}] ${escapeHtml(rec.partName)}<br>내역을 삭제하시겠습니까?`;
                $('deleteModal').classList.remove('hidden');
            }
        });

        // 비고 수정 (칸에서 벗어나거나 Enter 시 저장)
        view.addEventListener('change', async (e) => {
            if (e.target.dataset.act !== 'note') return;
            const rec = recordOf(e.target);
            if (!rec) return;
            rec.note = e.target.value.trim();
            try {
                await api.updateRecord(rec.id, { note: rec.note });
                showNotification('비고를 저장했습니다.', 'success');
            } catch (err) {
                showNotification('비고 저장 실패: ' + err.message, 'error');
            }
        });

        view.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.dataset.act === 'note') e.target.blur();
        });
    });

    $('deleteNo').addEventListener('click', () => $('deleteModal').classList.add('hidden'));

    $('deleteYes').addEventListener('click', async () => {
        $('deleteModal').classList.add('hidden');
        if (!pendingDeleteId) return;
        try {
            await api.deleteRecord(pendingDeleteId);
            records = records.filter((r) => r.id !== pendingDeleteId);
            renderRecords();
            showNotification('삭제했습니다.', 'success');
        } catch (err) {
            showNotification('삭제 응답을 받지 못했습니다. 목록을 다시 불러옵니다.', 'error');
            loadRecords();
        } finally {
            pendingDeleteId = null;
        }
    });

    // 모달 바깥 클릭 시 닫기
    document.querySelectorAll('.modal').forEach((modal) => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });

    /* ---------- 엑셀(CSV) 저장 ---------- */
    $('exportBtn').addEventListener('click', () => {
        const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = [['등록일시', '작성자', '사용라인', '자재품번', '품명', '업체', '담당자', '필요수량', '처리현황', '비고']];
        filteredRecords().forEach((r) => rows.push([r.createdAt, r.writer, r.line, r.partNo, r.partName, r.vendor, r.manager, r.qty, r.status, r.note]));
        // BOM: 엑셀에서 한글 깨짐 방지
        const csv = '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n');

        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = `자재결품_처리현황_${formatDateTime(new Date()).slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    /* ---------- 앱 설치(PWA) ----------
     * 인터넷 주소(https)로 열었을 때만 동작합니다. PC에서 파일을 직접 열면(file://) 건너뜁니다.
     */
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* 설치 실패해도 웹으로는 정상 사용 */ });
    }

    /* ---------- 시작 ---------- */
    loadMaster();
    loadLines();
    loadRecords(); // 헤더의 전체/대기/완료 건수 표시용
});
