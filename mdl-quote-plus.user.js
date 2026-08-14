// ==UserScript==
// @name         MDL Quote+
// @namespace    mdl.quote.plus
// @version      2.0.0
// @description  Fast inline defect photos and remark editing for Uptick quote pages.
// @author       MDL
// @match        *://*.onuptick.com/quoting/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (window.__MDL_QUOTE_PLUS_V2__) return;
    window.__MDL_QUOTE_PLUS_V2__ = true;

    const CONFIG = {
        scanMs: 1000,
        thumbW: 92,
        thumbH: 68,
        maxThumbs: 4
    };

    const cache = new Map();          // remarkId -> Promise<{remark, photos}>
    const mounted = new WeakMap();    // cell -> remarkId
    let scanTimer = null;

    function csrfToken() {
        const row = document.cookie.split('; ').find(v => v.startsWith('csrftoken='));
        return row ? decodeURIComponent(row.split('=').slice(1).join('=')) : '';
    }

    function injectStyles() {
        if (document.getElementById('mdlqp-v2-style')) return;
        const s = document.createElement('style');
        s.id = 'mdlqp-v2-style';
        s.textContent = `
            .mdlqp2 {
                margin-top: 6px;
                padding: 7px;
                border: 1px solid #d8dbe2;
                border-radius: 5px;
                background: #fff;
                width: min(360px, calc(100vw - 70px));
                box-sizing: border-box;
                font-size: 11px;
                line-height: 1.3;
            }
            .mdlqp2-head {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:8px;
                margin-bottom:5px;
                font-weight:600;
            }
            .mdlqp2-btn {
                border:1px solid #7a4aa8;
                background:#fff;
                color:#5c3b7a;
                border-radius:4px;
                padding:3px 7px;
                font-size:11px;
                cursor:pointer;
            }
            .mdlqp2-btn.primary {
                background:#7a4aa8;
                color:#fff;
            }
            .mdlqp2-btn:disabled { opacity:.6; cursor:wait; }
            .mdlqp2-label {
                display:block;
                font-weight:600;
                margin:5px 0 2px;
            }
            .mdlqp2-rec, .mdlqp2-notes {
                color:#444;
                white-space:pre-wrap;
            }
            .mdlqp2-gallery {
                display:flex;
                gap:5px;
                flex-wrap:wrap;
                margin-top:6px;
            }
            .mdlqp2-photo {
                width:${CONFIG.thumbW}px;
                height:${CONFIG.thumbH}px;
                object-fit:cover;
                border:1px solid #ddd;
                border-radius:4px;
                cursor:zoom-in;
                background:#f3f3f3;
            }
            .mdlqp2-muted { color:#777; margin-top:4px; }
            .mdlqp2-error { color:#b42318; margin-top:4px; }
            .mdlqp2-editor { margin-top:6px; }
            .mdlqp2-editor textarea {
                width:100%;
                min-height:62px;
                resize:vertical;
                box-sizing:border-box;
                border:1px solid #bbb;
                border-radius:4px;
                padding:6px;
                font:inherit;
            }
            .mdlqp2-actions {
                display:flex;
                gap:6px;
                margin-top:6px;
            }
            .mdlqp2-lightbox {
                position:fixed;
                inset:0;
                z-index:999999;
                display:flex;
                align-items:center;
                justify-content:center;
                background:rgba(0,0,0,.9);
                padding:24px;
            }
            .mdlqp2-lightbox img {
                max-width:95vw;
                max-height:92vh;
                object-fit:contain;
            }
            .mdlqp2-close {
                position:fixed;
                top:16px;
                right:22px;
                color:#fff;
                background:transparent;
                border:0;
                font-size:36px;
                cursor:pointer;
            }
            .mdlqp2-nav {
                position:fixed;
                top:50%;
                transform:translateY(-50%);
                width:42px;
                height:62px;
                border:0;
                border-radius:4px;
                background:rgba(255,255,255,.15);
                color:#fff;
                font-size:28px;
                cursor:pointer;
            }
            .mdlqp2-prev { left:18px; }
            .mdlqp2-next { right:18px; }

            /* Important: allow only the Remark cell content itself to grow. */
            .ag-cell[col-id="remarkId"].mdlqp2-cell {
                overflow:visible !important;
                white-space:normal !important;
            }
        `;
        document.head.appendChild(s);
    }

    function parseRemarkId(cell) {
        const m = (cell?.innerText || cell?.textContent || '').match(/\bD\s*-\s*(\d+)\b/i);
        return m ? m[1] : null;
    }

    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    function getDescriptionNode(cell, remarkId) {
        return Array.from(cell.querySelectorAll('span')).find(span => {
            if (span.closest('.mdlqp2')) return false;
            const t = (span.textContent || '').trim();
            return t && !/^D\s*-\s*\d+$/i.test(t);
        }) || null;
    }

    async function fetchJson(url, options = {}) {
        const r = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json', ...(options.headers || {}) },
            ...options
        });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.status === 204 ? null : r.json();
    }

    function loadRemarkBundle(id) {
        if (cache.has(id)) return cache.get(id);

        const p = Promise.all([
            fetchJson(`/api/v2/remarks/${id}/`, {
                headers: { Accept: 'application/vnd.api+json, application/json' }
            }),
            fetchJson(`/api/v2/uploads/remarks/${id}/photos/`)
        ]).then(([remarkPayload, photoPayload]) => {
            const a = remarkPayload?.data?.attributes || {};
            return {
                remark: {
                    description: a.description || a.get_description || '',
                    resolution: a.resolution || a.get_resolution || '',
                    notes: a.notes || '',
                    severity: a.get_severity_display || '',
                    status: a.status || ''
                },
                photos: Array.isArray(photoPayload?.files) ? photoPayload.files : []
            };
        }).catch(err => {
            cache.delete(id);
            throw err;
        });

        cache.set(id, p);
        return p;
    }

    async function saveRemark(id, description, resolution) {
        const token = csrfToken();
        const r = await fetch(`/api/v2/remarks/${id}/`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: {
                Accept: 'application/vnd.api+json, application/json',
                'Content-Type': 'application/vnd.api+json',
                ...(token ? { 'X-CSRFToken': token } : {})
            },
            body: JSON.stringify({
                data: {
                    type: 'Remark',
                    id: String(id),
                    attributes: { description, resolution }
                }
            })
        });
        if (!r.ok) throw new Error(`Save failed (${r.status})`);
        cache.delete(id);
    }

    function lightbox(files, start = 0) {
        if (!files.length) return;
        let idx = start;

        const box = document.createElement('div');
        box.className = 'mdlqp2-lightbox';
        const img = document.createElement('img');
        const close = document.createElement('button');
        close.className = 'mdlqp2-close';
        close.innerHTML = '&times;';
        const prev = document.createElement('button');
        prev.className = 'mdlqp2-nav mdlqp2-prev';
        prev.textContent = '‹';
        const next = document.createElement('button');
        next.className = 'mdlqp2-nav mdlqp2-next';
        next.textContent = '›';

        const render = () => {
            img.src = files[idx].preview_url || files[idx].url;
            prev.hidden = files.length < 2;
            next.hidden = files.length < 2;
        };

        const destroy = () => {
            document.removeEventListener('keydown', keyHandler);
            box.remove();
        };

        const keyHandler = e => {
            if (e.key === 'Escape') destroy();
            if (e.key === 'ArrowLeft') { idx = (idx - 1 + files.length) % files.length; render(); }
            if (e.key === 'ArrowRight') { idx = (idx + 1) % files.length; render(); }
        };

        close.onclick = destroy;
        prev.onclick = () => { idx = (idx - 1 + files.length) % files.length; render(); };
        next.onclick = () => { idx = (idx + 1) % files.length; render(); };
        box.onclick = e => { if (e.target === box) destroy(); };
        document.addEventListener('keydown', keyHandler);

        box.append(img, close, prev, next);
        document.body.appendChild(box);
        render();
    }

    function ensureRowHeight(cell, panel) {
        const row = cell.closest('.ag-row');
        if (!row) return;

        requestAnimationFrame(() => {
            const needed = Math.max(42, panel.scrollHeight + 48);
            const current = parseFloat(row.style.height || '0') || row.getBoundingClientRect().height;
            if (needed <= current + 2) return;

            const rowIndex = row.getAttribute('row-index');
            if (rowIndex == null) return;

            // Use AG Grid's existing row structure. We only enlarge the matching row fragments.
            document.querySelectorAll(`.ag-row[row-index="${CSS.escape(rowIndex)}"]`).forEach(part => {
                part.style.height = `${needed}px`;
                part.style.minHeight = `${needed}px`;
            });
        });
    }

    function mountCell(cell, id) {
        const prior = mounted.get(cell);
        if (prior === id && cell.querySelector(`.mdlqp2[data-remark-id="${id}"]`)) return;

        cell.querySelectorAll('.mdlqp2').forEach(n => n.remove());
        mounted.set(cell, id);
        cell.classList.add('mdlqp2-cell');

        const descNode = getDescriptionNode(cell, id);
        let currentDescription = descNode?.textContent?.trim() || '';
        let currentResolution = '';

        const panel = document.createElement('div');
        panel.className = 'mdlqp2';
        panel.dataset.remarkId = id;

        const head = document.createElement('div');
        head.className = 'mdlqp2-head';
        const title = document.createElement('span');
        title.textContent = 'Defect details';
        const edit = document.createElement('button');
        edit.className = 'mdlqp2-btn';
        edit.type = 'button';
        edit.textContent = 'Edit remark';
        head.append(title, edit);

        const body = document.createElement('div');
        body.innerHTML = `<div class="mdlqp2-muted">Loading…</div>`;

        panel.append(head, body);
        (cell.querySelector('.w-100') || cell).appendChild(panel);
        ensureRowHeight(cell, panel);

        loadRemarkBundle(id).then(({ remark, photos }) => {
            currentDescription = remark.description || currentDescription;
            currentResolution = remark.resolution || '';

            body.innerHTML = '';

            if (currentResolution) {
                const label = document.createElement('span');
                label.className = 'mdlqp2-label';
                label.textContent = 'Recommendation';
                const rec = document.createElement('div');
                rec.className = 'mdlqp2-rec';
                rec.textContent = currentResolution;
                body.append(label, rec);
            }

            if (remark.notes) {
                const label = document.createElement('span');
                label.className = 'mdlqp2-label';
                label.textContent = 'Technician notes';
                const notes = document.createElement('div');
                notes.className = 'mdlqp2-notes';
                notes.textContent = remark.notes;
                body.append(label, notes);
            }

            if (photos.length) {
                const label = document.createElement('span');
                label.className = 'mdlqp2-label';
                label.textContent = 'Defect photos';
                const gallery = document.createElement('div');
                gallery.className = 'mdlqp2-gallery';

                photos.slice(0, CONFIG.maxThumbs).forEach((file, i) => {
                    const im = document.createElement('img');
                    im.className = 'mdlqp2-photo';
                    im.loading = 'lazy';
                    im.src = file.thumbnail_url || file.preview_url || file.url;
                    im.alt = `Defect photo ${i + 1}`;
                    im.onclick = () => lightbox(photos, i);
                    gallery.appendChild(im);
                });

                body.append(label, gallery);
            } else {
                const none = document.createElement('div');
                none.className = 'mdlqp2-muted';
                none.textContent = 'No defect photos attached.';
                body.appendChild(none);
            }

            ensureRowHeight(cell, panel);
        }).catch(err => {
            body.innerHTML = '';
            const e = document.createElement('div');
            e.className = 'mdlqp2-error';
            e.textContent = `Unable to load defect details (${err.message})`;
            body.appendChild(e);
            ensureRowHeight(cell, panel);
        });

        edit.onclick = async () => {
            edit.hidden = true;

            const editor = document.createElement('div');
            editor.className = 'mdlqp2-editor';

            const dl = document.createElement('span');
            dl.className = 'mdlqp2-label';
            dl.textContent = 'Description';
            const d = document.createElement('textarea');
            d.value = currentDescription;

            const rl = document.createElement('span');
            rl.className = 'mdlqp2-label';
            rl.textContent = 'Recommendation';
            const r = document.createElement('textarea');
            r.value = currentResolution;

            const actions = document.createElement('div');
            actions.className = 'mdlqp2-actions';
            const save = document.createElement('button');
            save.className = 'mdlqp2-btn primary';
            save.textContent = 'Save';
            const cancel = document.createElement('button');
            cancel.className = 'mdlqp2-btn';
            cancel.textContent = 'Cancel';
            const status = document.createElement('span');
            status.className = 'mdlqp2-muted';

            actions.append(save, cancel, status);
            editor.append(dl, d, rl, r, actions);
            panel.appendChild(editor);
            d.focus();
            ensureRowHeight(cell, panel);

            cancel.onclick = () => {
                editor.remove();
                edit.hidden = false;
                ensureRowHeight(cell, panel);
            };

            save.onclick = async () => {
                const newD = d.value.trim();
                const newR = r.value.trim();
                if (!newD) {
                    status.textContent = 'Description cannot be blank.';
                    return;
                }

                save.disabled = true;
                cancel.disabled = true;
                status.textContent = 'Saving…';

                try {
                    await saveRemark(id, newD, newR);
                    currentDescription = newD;
                    currentResolution = newR;
                    if (descNode) descNode.textContent = newD;
                    editor.remove();
                    edit.hidden = false;

                    // Refresh this panel only.
                    mounted.delete(cell);
                    mountCell(cell, id);
                } catch (e) {
                    status.textContent = e.message;
                    save.disabled = false;
                    cancel.disabled = false;
                }
            };
        };
    }

    function scan() {
        // Critical change: work from every visible remark cell directly.
        // This avoids depending on row order, quote API timing, or the first-row rendering sequence.
        const cells = Array.from(document.querySelectorAll('.ag-cell[col-id="remarkId"]'))
            .filter(isVisible);

        for (const cell of cells) {
            const id = parseRemarkId(cell);
            if (!id) continue;
            mountCell(cell, id);
        }
    }

    function start() {
        injectStyles();
        scan();

        // Lightweight 1s scan of only visible Remark cells.
        // Already-mounted cells return immediately and trigger no API requests.
        scanTimer = setInterval(scan, CONFIG.scanMs);

        console.info('[MDL Quote+] v2.0.0 loaded');
    }

    start();
})();
