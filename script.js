let activeSession = null, questions = [], qIndex = 0, qTimer, totalTimer, autoSaveInterval, questionDurationTimer;
let totalSeconds = 0, qSecondsLeft = 0;
let recentHistory = JSON.parse(localStorage.getItem("QUIZ_HISTORY") || "[]");
let quizChart = null;

window.onload = () => {
    renderRecentQuizzes();
    // Start in Home Mode (Full Width, Centered)
    const appContainer = document.querySelector('.app-container');
    if(appContainer) appContainer.classList.remove('quiz-mode');
};

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearInterval(qTimer);
        clearInterval(totalTimer);
        clearInterval(questionDurationTimer);
    } else if (activeSession && activeSession.status === "in-progress") {
        startTotalTimer();
        trackQuestionTime();
        resumeQuestionTimer();
    }
});

function updateFileName(input, displayId) {
  document.getElementById(displayId).innerText = input.files[0]?.name || "Select File";
}

function renderRecentQuizzes() {
  const list = document.getElementById("recentQuizzesList");
  const clearBtn = document.getElementById("clearAllBtn");
  list.innerHTML = recentHistory.length ? "" : "<p class='empty-text'>No recent sessions.</p>";
  clearBtn.classList.toggle("hidden", recentHistory.length === 0);

  recentHistory.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "recent-item";
    div.innerHTML = `
        <span class="recent-title">${item.title}</span>
        <div class="recent-actions">
            <button class="btn-xs btn-primary" onclick="resumeFromHistory(${index})">Resume</button>
            <button class="btn-xs btn-danger" onclick="deleteHistory(${index})">✕</button>
        </div>`;
    list.appendChild(div);
  });
}

function startNewSession() {
  const f = document.getElementById("fileInput").files[0];
  const shouldShuffle = document.getElementById("shuffleToggle").checked;
  const userMark = document.getElementById("markInput").value;
  const userNeg = document.getElementById("negInput").value;

  if (!f) return alert("Please select a Quiz JSON.");
  const r = new FileReader();
  r.onload = (e) => {
    try {
        const data = JSON.parse(e.target.result);
        let rawList = [];

        if (Array.isArray(data)) {
            rawList = data;
        } else {
            rawList = data.sections ? data.sections.flatMap(s => s.questions) : (data.questions || []);
        }

        let flatQ = rawList.map(q => ({
            q: q.q || q.question,
            options: q.options,
            answer: (q.answer || q.answer_key || "").toUpperCase(),
            explanation: q.explanation || "",
            source: q.source || "",
            sel: null,
            flag: false,
            timeSpent: 0
        }));

        if (shouldShuffle) {
            for (let i = flatQ.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [flatQ[i], flatQ[j]] = [flatQ[j], flatQ[i]];
            }
        }

        const finalMark = userMark ? parseFloat(userMark) : (data.markPerQuestion !== undefined ? data.markPerQuestion : 1.666666666667);
        const finalNeg = userNeg ? parseFloat(userNeg) : (data.negativeMark !== undefined ? data.negativeMark : 0.55555555556);

        // Store original filename for sync saving later
        const originalName = f.name.replace(/\.json$/i, "");

        activeSession = { 
            status: "in-progress", 
            title: data.title || originalName,
            originalFileName: originalName,
            questions: flatQ, 
            qIndex: 0, 
            totalSeconds: 0,
            settings: { 
                time: data.timeLimit || 60, 
                mark: finalMark, 
                neg: finalNeg 
            }
        };
        saveAndLoad();
    } catch(err) {
        alert("Error loading JSON. Ensure the format is correct.");
        console.error(err);
    }
  };
  r.readAsText(f);
}

function importSyncFileManual() { 
    const f = document.getElementById('importInput').files[0]; 
    if(!f) return; 
    const r = new FileReader(); 
    r.onload = (e) => { activeSession = JSON.parse(e.target.result); saveAndLoad(); }; 
    r.readAsText(f); 
}

function saveAndLoad() { saveToHistory(); loadSession(); }

function loadSession() {
  // Activate Quiz Layout (Grid Mode)
  document.querySelector('.app-container').classList.add('quiz-mode');

  questions = activeSession.questions; qIndex = activeSession.qIndex; totalSeconds = activeSession.totalSeconds;
  startTotalTimer(); loadQuestion();
  
  clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(autoSave, 5000); 
}

// --- INTELLIGENT TEXT PROCESSING ---

function smartHighlight(text) {
    if (!text) return "";
    let processed = text;
    // Highlight Acts, Years, Articles
    processed = processed.replace(/(\b\d{4}\b|Article \d+|Section \d+|Schedule \d+|Amendment|Act \d{4})/gi, '<span class="highlight-term">$1</span>');
    // Highlight Logic Markers
    processed = processed.replace(/(Option [a-d] is [a-z ]*correct:?|Statement \d+ is [a-z ]*correct:?|Pair [IVX\d]+ is [a-z ]*correct:?|Pair [IVX\d]+ is [a-z ]*incorrect:?)/gi, '<span class="highlight-statement">$1</span>');
    // Highlight Headers
    processed = processed.replace(/\b([A-Z][a-z]+:)/g, '<span class="definition-header">$1</span>');
    return processed;
}

function smartBreakParagraphs(text, maxChars = 350) {
    if (!text) return [];
    
    // Force breaks on logical keywords
    let processed = text.replace(/(Pair [IVX\d]+ is (?:in)?correct:?|Statement \d+ is (?:in)?correct:?|Option [a-d] is (?:in)?correct:?)/gi, '||LOGIC_SPLIT||$1');
    processed = processed.replace(/\b([A-Z][a-z]+:)/g, '||LOGIC_SPLIT||$1');
    
    let rawSegments = processed.split('||LOGIC_SPLIT||');
    let finalParagraphs = [];

    const splitSentencesSafe = (str) => {
        const tokens = str.split(/([.!?]+(?:\s+|$))/);
        let result = [];
        let buffer = "";
        let openParenCount = 0;
        for (let i = 0; i < tokens.length; i++) {
            let part = tokens[i];
            buffer += part;
            for(let char of part) {
                if(char === '(') openParenCount++;
                if(char === ')') openParenCount--;
            }
            if (i % 2 !== 0 && openParenCount === 0) {
                result.push(buffer);
                buffer = "";
            }
        }
        if (buffer.trim()) result.push(buffer);
        return result;
    };

    rawSegments.forEach(segment => {
        segment = segment.trim();
        if (!segment) return;
        if (segment.length < maxChars) {
            finalParagraphs.push(segment);
        } else {
            let sentences = splitSentencesSafe(segment);
            let currentChunk = "";
            sentences.forEach(sentence => {
                if ((currentChunk + sentence).length > maxChars) {
                    if (currentChunk.trim()) finalParagraphs.push(currentChunk.trim());
                    currentChunk = sentence;
                } else {
                    currentChunk += sentence;
                }
            });
            if (currentChunk.trim()) finalParagraphs.push(currentChunk.trim());
        }
    });
    return finalParagraphs;
}

function processTextSmartly(text) {
    if (!text) return "";
    const paragraphs = smartBreakParagraphs(text);
    return paragraphs.map(p => `<p>${smartHighlight(p)}</p>`).join('');
}

// --- QUESTION FORMATTER (No Matrix, Clean Bullets) ---
function formatQuestionText(text) {
    if (!text) return "";
    let formatted = text;

    // 1. LONG QUOTES ON NEW LINE
    // Only if length > 30 characters
    formatted = formatted.replace(/([^\n>])\s*([“"][^”"]{30,}[”"])/g, '$1<br><span class="q-quote">$2</span>');

    // 2. BULLET POINTS (Strict New Line & Spacing)
    
    // Roman (I. II. III.)
    formatted = formatted.replace(/(\s|^)((?:I{1,3}|IV|V|VI{0,3}|IX|X)\.)\s+/g, '<br><span class="q-point">$2&nbsp;</span>');
    
    // Numbered (1. 2. 3.)
    formatted = formatted.replace(/(\s|^)(\(?\d+\.)\s+/g, '<br><span class="q-point">$2&nbsp;</span>');
    
    // Letters ((a) (b) or a. b.) - Guard against e.g. / i.e.
    formatted = formatted.replace(/(\s|^)(\(?[a-z]\)[\.\)])\s+(?![a-z]\.)/gi, '<br><span class="q-point">$2&nbsp;</span>');

    // Symbols
    formatted = formatted.replace(/([^\n])\s*([•\-\*])\s+/g, '$1<br><span class="q-point">$2&nbsp;</span>');

    // 3. ASSERTION / REASON
    formatted = formatted.replace(/(Assertion\s*\(?A\)?\s*[:.-])/gi, '<br><div class="ar-box"><strong>$1</strong>');
    formatted = formatted.replace(/(Reason\s*\(?R\)?\s*[:.-])/gi, '</div><div class="ar-box"><strong>$1</strong>');

    // Cleanup
    formatted = formatted.replace(/(<br>){2,}/g, '<br>').replace(/^<br>/, ''); 

    return formatted;
}

function openExplanationInTab(fullExplanation, qNum) {
    const parts = fullExplanation.split("||TIPS||");
    const mainExp = parts[0];
    const tips = parts.length > 1 ? parts[1] : null;

    const win = window.open("", "_blank");
    win.document.write(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>Q${qNum} Explanation</title>
            <style>
                * { box-sizing: border-box; }
                :root { --bg-color: #f8f9fa; --text-color: #2c3e50; --card-bg: #ffffff; --border-color: #D4E6F1; --highlight-term: #d35400; --highlight-stmt-bg: rgba(39, 174, 96, 0.1); --highlight-stmt-text: #27ae60; --highlight-def: #119627; --tips-bg: #E8F8F5; --tips-border: #1abc9c; --tips-header: #16a085; --btn-bg: #34495e; --btn-hover: #2c3e50; }
                [data-theme="dark"] { --bg-color: #1a1a1a; --text-color: #e0e0e0; --card-bg: #2d2d2d; --border-color: #404040; --highlight-term: #e67e22; --highlight-stmt-bg: rgba(39, 174, 96, 0.2); --highlight-stmt-text: #2ecc71; --highlight-def: #1dcf23; --tips-bg: #2c3e50; --tips-border: #16a085; --tips-header: #1abc9c; --btn-bg: #4a69bd; --btn-hover: #1e3799; }
                
                body { background: var(--bg-color); color: var(--text-color); font-family: 'Segoe UI', system-ui, sans-serif; padding: 0; margin: 0; line-height: 1.6; transition: background 0.3s, color 0.3s; }
                
                /* EXPLANATION PAGE: 96% WIDTH IN PORTRAIT */
                .container { 
                    width: 96%; 
                    max-width: 96%; /* Forces 96% on mobile/portrait */
                    min-height: 100vh; 
                    margin: 10px auto; 
                    background: var(--card-bg); 
                    padding: 20px; 
                    border-radius: 8px; /* Slight rounded corners */
                    box-shadow: none; 
                }
                
                /* DESKTOP/LANDSCAPE: Restored Card Layout */
                @media screen and (min-width: 768px) { 
                    .container { 
                        width: 94%;
                        max-width: 880px; 
                        margin: 20px auto; 
                        padding: 40px; 
                        border-radius: 12px; 
                        box-shadow: 0 10px 30px rgba(0,0,0,0.3); 
                        min-height: auto; 
                    } 
                }

                .header-row { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--border-color); padding-bottom: 15px; margin-bottom: 25px; }
                h1 { margin: 0; font-size: 1.3rem; color: var(--text-color); }
                .theme-toggle { background: none; border: 1px solid var(--text-color); color: var(--text-color); padding: 6px 12px; border-radius: 20px; cursor: pointer; font-weight: 600; font-size: 0.9rem; }
                p { margin-bottom: 15px; font-size: 1.05rem; text-align: left; }
                .highlight-term { font-weight: bold; color: var(--highlight-term); }
                .highlight-statement { font-weight: bold; color: var(--highlight-stmt-text); background-color: var(--highlight-stmt-bg); padding: 2px 6px; border-radius: 4px; }
                .definition-header { font-weight: 400; color: var(--highlight-def); }
                .tips-box { margin-top: 30px; background-color: var(--tips-bg); border-left: 5px solid var(--tips-border); padding: 15px; border-radius: 4px; }
                .tips-header { font-weight: 800; color: var(--tips-header); font-size: 1rem; margin-bottom: 10px; display: block; text-transform: uppercase; letter-spacing: 0.5px; }
                .close-btn { display: block; width: 100%; margin-top: 30px; background: var(--btn-bg); color: white; border: none; padding: 14px; border-radius: 8px; cursor: pointer; font-size: 1rem; font-weight: 600; }
            </style>
        </head>
        <body data-theme="dark">
            <div class="container">
                <div class="header-row">
                    <h1>Question ${qNum} Analysis</h1>
                    <button class="theme-toggle" onclick="toggleTheme()">🌗 Theme</button>
                </div>
                <div class="content">${processTextSmartly(mainExp)}</div>
                ${tips ? `<div class="tips-box"><span class="tips-header">💡 Important Tips</span>${processTextSmartly(tips)}</div>` : ''}
                <button class="close-btn" onclick="window.close()">Close Tab & Resume Quiz</button>
            </div>
            <script>
                function toggleTheme() {
                    const body = document.body;
                    const current = body.getAttribute('data-theme');
                    const next = current === 'dark' ? 'light' : 'dark';
                    body.setAttribute('data-theme', next);
                }
            </script>
        </body>
        </html>
    `);
}

function loadQuestion() {
  document.getElementById("home").classList.add("hidden");
  document.getElementById("quiz").classList.remove("hidden");
  document.getElementById("sidebar").classList.remove("hidden");
  
  const q = questions[qIndex];
  if (typeof q.timeSpent === 'undefined') q.timeSpent = 0;

  document.getElementById("questionCounter").innerText = `Q${qIndex + 1} / ${questions.length}`;
  let qHtml = (q.flag ? "🚩 " : "") + formatQuestionText(q.q);
  if(q.source) qHtml += `<span class="source-tag">Source: ${q.source}</span>`;
  document.getElementById("question").innerHTML = qHtml;

  const optionsContainer = document.getElementById("optionsContainer");
  optionsContainer.innerHTML = "";
  const keys = Object.keys(q.options);
  keys.forEach(key => {
      const btn = document.createElement("button");
      btn.className = "option-btn";
      btn.innerText = q.options[key];
      const normalizedKey = key.toUpperCase();
      if (q.sel === normalizedKey) btn.classList.add("selected");
      if (q.sel && !q.flag) {
          if (normalizedKey === q.answer) btn.classList.add("correct");
          else if (normalizedKey === q.sel) btn.classList.add("wrong");
      }
      btn.disabled = (q.sel !== null);
      btn.onclick = () => selectOption(normalizedKey);
      optionsContainer.appendChild(btn);
  });

  const fb = document.getElementById("feedback");
  const fbStatus = document.getElementById("feedbackStatus");
  const fbBody = document.getElementById("feedbackBody");
  const fbLink = document.getElementById("feedbackLink");

  if (q.sel) {
    fbStatus.innerHTML = `<strong>${q.sel === q.answer ? "✅ Correct" : "❌ Incorrect"}</strong>`;
    if (q.explanation.length > 350 || q.explanation.includes("||TIPS||")) {
        fbBody.innerHTML = "<p><i>The explanation for this question is detailed and may contain additional tips.</i></p>";
        fbLink.innerHTML = `<span class="exp-link" onclick="openExplanationInTab(questions[qIndex].explanation, ${qIndex+1})">📖 View Full Analysis in New Tab</span>`;
    } else {
        fbBody.innerHTML = `<div class="beautified-explanation">${processTextSmartly(q.explanation)}</div>`;
        fbLink.innerHTML = "";
    }
    fb.classList.remove("hidden");
  } else fb.classList.add("hidden");

  document.getElementById("flagBtn").disabled = (q.sel !== null);
  updateSidebar(); updateNav(); startQuestionTimer(); trackQuestionTime();
}

function selectOption(o) { if(questions[qIndex].sel) return; questions[qIndex].sel = o; if(questions[qIndex].flag) questions[qIndex].flag = false; loadQuestion(); }
function toggleFlag() { if(questions[qIndex].sel) return; questions[qIndex].flag = !questions[qIndex].flag; loadQuestion(); }
function next() { if(qIndex < questions.length - 1) { qIndex++; loadQuestion(); } }
function prev() { if(qIndex > 0) { qIndex--; loadQuestion(); } }

function startTotalTimer() { totalTimer = setInterval(() => { totalSeconds++; document.getElementById("totalTimer").innerText = `Total: ${Math.floor(totalSeconds/60)}:${(totalSeconds%60).toString().padStart(2,'0')}`; }, 1000); }
function startQuestionTimer() { clearInterval(qTimer); qSecondsLeft = activeSession.settings.time; resumeQuestionTimer(); }
function resumeQuestionTimer() { qTimer = setInterval(() => { qSecondsLeft--; document.getElementById("questionTimer").innerText = qSecondsLeft + "s"; if(qSecondsLeft<=0) next(); }, 1000); }
function trackQuestionTime() { clearInterval(questionDurationTimer); questionDurationTimer = setInterval(() => { questions[qIndex].timeSpent = (questions[qIndex].timeSpent || 0) + 1; }, 1000); }

function updateNav() { 
    const isLast = qIndex === questions.length - 1; 
    document.getElementById("submitBtn").classList.toggle("hidden", !isLast); 
    document.getElementById("nextBtn").classList.toggle("hidden", isLast); 
    document.getElementById("progressBar").style.width = ((qIndex+1)/questions.length*100) + "%"; 
}

function updateSidebar() { 
  const flagList = document.getElementById("flaggedList"); 
  const unattemptedList = document.getElementById("unattemptedList");
  const flagCountSpan = document.getElementById("flagCount");
  const unattemptedCountSpan = document.getElementById("unattemptedCount");
  flagList.innerHTML = ""; unattemptedList.innerHTML = "";
  let fCount = 0; let uCount = 0;
  questions.forEach((q, i) => { 
    if (q.flag) { fCount++; createSidebarItem(flagList, i); } 
    else if (!q.sel) { uCount++; createSidebarItem(unattemptedList, i); }
  });
  flagCountSpan.innerText = fCount; unattemptedCountSpan.innerText = uCount;
}

function createSidebarItem(container, i) {
    const d = document.createElement("div"); 
    d.className = "flag-pill"; 
    d.innerText = `Q${i+1}`; 
    d.onclick = () => { qIndex = i; loadQuestion(); }; 
    container.appendChild(d);
}

function toggleSection(listId, btn) {
    const list = document.getElementById(listId);
    if (list.classList.contains("hidden")) { list.classList.remove("hidden"); btn.innerText = "_"; } 
    else { list.classList.add("hidden"); btn.innerText = "+"; }
}

function finishQuiz() {
  if (!confirm("Submit your answers?")) return;
  clearInterval(qTimer); clearInterval(totalTimer); clearInterval(autoSaveInterval); clearInterval(questionDurationTimer);
  let c = 0, w = 0, u = 0;
  questions.forEach(q => { if(!q.sel) u++; else if(q.sel===q.answer) c++; else w++; });
  const rawScore = (c * activeSession.settings.mark) - (w * activeSession.settings.neg);
  const score = Number.isInteger(rawScore) ? rawScore : Number(rawScore.toFixed(2));
  activeSession.report = { c, w, u, score, total: questions.length };
  activeSession.status = "completed";
  recentHistory = recentHistory.filter(q => q.title !== activeSession.title);
  localStorage.setItem("QUIZ_HISTORY", JSON.stringify(recentHistory));
  showReport();
}

function showReport() {
  const r = activeSession.report;
  document.getElementById("quiz").classList.add("hidden");
  document.getElementById("sidebar").classList.add("hidden");
  document.getElementById("reportView").classList.remove("hidden");
  const fmt = (n) => Number.isInteger(n) ? n : n.toFixed(2);
  document.getElementById("statSummary").innerHTML = `
    <div class="stat-card"><h2>${fmt(r.score)}</h2><p>Score</p></div>
    <div class="stat-card text-success"><h2>${r.c}</h2><p>Correct</p></div>
    <div class="stat-card text-danger"><h2>${r.w}</h2><p>Wrong</p></div>`;
  if (quizChart) quizChart.destroy();
  const ctx = document.getElementById('accuracyChart');
  quizChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['Correct', 'Wrong', 'Skipped'], datasets: [{ data: [r.c, r.w, r.u], backgroundColor: ['#10b981', '#ef4444', '#334155'], borderWidth: 0 }] },
    options: { plugins: { legend: { position: 'bottom', labels: { color: '#f1f5f9', font: { size: 14 } } } } }
  });
}

async function generateAnalyticPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const r = activeSession.report;
  const s = activeSession.settings;
  if (quizChart) {
    quizChart.options.plugins.legend.labels.color = '#000000';
    const whiteBgPlugin = { id: 'whiteBg', beforeDraw: (chart) => { const ctx = chart.canvas.getContext('2d'); ctx.save(); ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, chart.width, chart.height); ctx.restore(); } };
    Chart.register(whiteBgPlugin); quizChart.update(); await new Promise(resolve => setTimeout(resolve, 500)); 
    const chartImg = document.getElementById('accuracyChart').toDataURL('image/jpeg', 1.0);
    Chart.unregister(whiteBgPlugin); quizChart.options.plugins.legend.labels.color = '#f1f5f9'; quizChart.update();
    const fmt = (num) => Number.isInteger(num) ? num : Number(num.toFixed(2));
    const attempted = r.c + r.w;
    const accuracyVal = attempted > 0 ? (r.c / attempted) * 100 : 0;
    const maxScoreVal = questions.length * s.mark;
    const percentageVal = maxScoreVal > 0 ? (r.score / maxScoreVal) * 100 : 0;
    const avgTimeVal = questions.length > 0 ? totalSeconds / questions.length : 0;
    const correctScoreVal = r.c * s.mark;
    const wrongScoreVal = r.w * s.neg;
    doc.setFillColor(30, 41, 59); doc.rect(0, 0, 210, 30, 'F'); doc.setTextColor(255, 255, 255); doc.setFontSize(18);
    doc.text(activeSession.title.substring(0, 40).toUpperCase(), 14, 19);
    const tableData = [ ['Total Questions', questions.length], ['Attempted', attempted], ['Accuracy', `${fmt(accuracyVal)}%`], ['Percentage', `${fmt(percentageVal)}%`], ['Avg Time / Question', `${fmt(avgTimeVal)}s`], ['Correct (+'+fmt(s.mark)+')', `${r.c} (+${fmt(correctScoreVal)})`], ['Wrong (-'+fmt(s.neg)+')', `${r.w} (-${fmt(wrongScoreVal)})`], ['FINAL SCORE', `${fmt(r.score)} / ${fmt(maxScoreVal)}`] ];
    doc.autoTable({ startY: 40, head: [['Metric', 'Value']], body: tableData, theme: 'grid', headStyles: { fillColor: [51, 65, 85] } });
    doc.addImage(chartImg, 'JPEG', 15, doc.lastAutoTable.finalY + 10, 80, 80);
    const rows = questions.map((q, i) => [ `Q${i+1}`, q.q, q.sel || '-', q.answer, q.sel === q.answer ? 'YES' : 'NO', q.timeSpent + "s" ]);
    doc.autoTable({ startY: doc.lastAutoTable.finalY + 100, head: [['#', 'Question', 'Yours', 'Key', 'Pass', 'Time']], body: rows, headStyles: { fillColor: [99, 102, 241] }, columnStyles: { 1: { cellWidth: 80 }, 5: { halign: 'center' } }, styles: { fontSize: 8, valign: 'middle' }, didParseCell: function(data) { if (data.section === 'body' && data.column.index === 4) { data.cell.styles.textColor = data.cell.raw === 'YES' ? [22, 163, 74] : [220, 38, 38]; } } });
    doc.save(`${activeSession.title}_Full_Report.pdf`);
  }
}

function autoSave() { activeSession.qIndex = qIndex; activeSession.totalSeconds = totalSeconds; saveToHistory(); }
function saveToHistory() { recentHistory = [activeSession, ...recentHistory.filter(q => q.title !== activeSession.title)].slice(0, 8); localStorage.setItem("QUIZ_HISTORY", JSON.stringify(recentHistory)); }
function resumeFromHistory(i) { activeSession = recentHistory[i]; loadSession(); }
function deleteHistory(i) { recentHistory.splice(i, 1); localStorage.setItem("QUIZ_HISTORY", JSON.stringify(recentHistory)); renderRecentQuizzes(); }
function clearAllHistory() { recentHistory = []; localStorage.removeItem("QUIZ_HISTORY"); renderRecentQuizzes(); }

// --- FILE SAVING WITH TIMESTAMP ---
function exitSession() { 
    if(!confirm("Save progress and exit?")) return;
    autoSave();
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(activeSession));
    const dlNode = document.createElement('a');
    
    // Generate Timestamp YYYY-MM-DD_HH-MM
    const now = new Date();
    const timestamp = now.getFullYear() + "-" +
        String(now.getMonth() + 1).padStart(2, '0') + "-" +
        String(now.getDate()).padStart(2, '0') + "_" +
        String(now.getHours()).padStart(2, '0') + "-" +
        String(now.getMinutes()).padStart(2, '0');

    // Use original file name if available
    const baseName = activeSession.originalFileName || activeSession.title || "quiz";
    
    dlNode.setAttribute("href", dataStr);
    dlNode.setAttribute("download", `${baseName}_${timestamp}_sync.json`);
    dlNode.click();
    location.reload(); 
}