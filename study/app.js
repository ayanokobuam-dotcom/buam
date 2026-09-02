/* =========================================================================
   Active Recall — app shell, router and screens
   -------------------------------------------------------------------------
   No framework/build step (matches the rest of this repo): screens are
   small functions that return HTML strings, composed like components
   (LessonViewer, RecallEditor, RecallComparison, RecallRating, ReviewCard,
   ProgressIndicator, SubjectSelector, TopicSelector...) even though there
   is no component runtime underneath them. A hash router re-renders the
   whole #root on every navigation; each screen wires up its own listeners
   in a mount() callback after its HTML lands in the DOM.
   ========================================================================= */

(function () {
  "use strict";

  var Data = window.RecallData;
  Data.seedIfNeeded();

  var root = document.getElementById("root");

  /* Transient, in-memory only: which active_recall_session the current
     recall/compare flow belongs to. Losing this on refresh is fine — the
     recall_note itself is already persisted once it's saved. */
  var currentSessionId = null;

  /* ----------------------------------------------------------------- */
  /* Small helpers                                                      */
  /* ----------------------------------------------------------------- */

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function navigate(hash) {
    if (location.hash === hash) {
      render();
    } else {
      location.hash = hash;
    }
  }

  var ICONS = {
    home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9h12v-9"/>',
    learn: '<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
    review: '<path d="M4 12a8 8 0 0 1 14-5.2M20 12a8 8 0 0 1-14 5.2"/><path d="M18 3v4h-4M6 21v-4h4"/>',
    progress: '<path d="M4 20V10M12 20V4M20 20v-7"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    back: '<path d="m11 5-7 7 7 7"/><path d="M4 12h16"/>',
    theme: '<path d="M12 4v1M12 19v1M4 12H3M21 12h-1M6.3 6.3l-.7-.7M18.4 18.4l-.7-.7M6.3 17.7l-.7.7M18.4 5.6l-.7.7"/><circle cx="12" cy="12" r="4.5"/>'
  };

  function icon(name) {
    return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + "</svg>";
  }

  function toast(message) {
    var node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    document.body.appendChild(node);
    requestAnimationFrame(function () {
      node.classList.add("visible");
    });
    setTimeout(function () {
      node.classList.remove("visible");
      setTimeout(function () {
        node.remove();
      }, 250);
    }, 1800);
  }

  /* ----------------------------------------------------------------- */
  /* Theme toggle (persisted, respects prefers-color-scheme by default) */
  /* ----------------------------------------------------------------- */

  function currentTheme() {
    try {
      return localStorage.getItem("activeRecall.theme") || "";
    } catch (e) {
      return "";
    }
  }
  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }
  function toggleTheme() {
    var isDark =
      currentTheme() === "dark" ||
      (currentTheme() === "" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var next = isDark ? "light" : "dark";
    try {
      localStorage.setItem("activeRecall.theme", next);
    } catch (e) {}
    applyTheme(next);
  }
  applyTheme(currentTheme());

  /* ----------------------------------------------------------------- */
  /* Router                                                             */
  /* ----------------------------------------------------------------- */

  function parseHash() {
    var hash = location.hash.replace(/^#\/?/, "");
    return hash.split("/").filter(Boolean);
  }

  function resolveScreen(parts) {
    if (parts.length === 0 || parts[0] === "home") return Screens.home();
    if (parts[0] === "learn" && parts.length === 1) return Screens.subjects();
    if (parts[0] === "learn" && parts[1] === "subject" && parts[2]) return Screens.topics(parts[2]);
    if (parts[0] === "learn" && parts[1] === "topic" && parts[2]) return Screens.lessons(parts[2]);
    if (parts[0] === "lesson" && parts[2] === "section" && parts[3]) return Screens.lessonSection(parts[1], parts[3]);
    if (parts[0] === "ready" && parts[1] && parts[2]) return Screens.ready(parts[1], parts[2]);
    if (parts[0] === "recall" && parts[1] && parts[2]) return Screens.recall(parts[1], parts[2]);
    if (parts[0] === "compare" && parts[1]) return Screens.compare(parts[1]);
    if (parts[0] === "history" && parts[1]) return Screens.historyDetail(parts[1]);
    if (parts[0] === "history") return Screens.history();
    if (parts[0] === "progress") return Screens.progress();
    return Screens.home();
  }

  function navItem(view, label, iconName, href) {
    var active = view === CURRENT_NAV;
    return (
      '<a class="app-nav-link' +
      (active ? " active" : "") +
      '" href="' +
      href +
      '">' +
      icon(iconName) +
      "<span>" +
      label +
      "</span></a>"
    );
  }

  function tabItem(view, label, iconName, href) {
    var active = view === CURRENT_NAV;
    return (
      '<a class="app-tab' +
      (active ? " active" : "") +
      '" href="' +
      href +
      '">' +
      icon(iconName) +
      "<span>" +
      label +
      "</span></a>"
    );
  }

  var CURRENT_NAV = "home";

  function shellHtml(bodyHtml) {
    return (
      '<div class="app-shell">' +
      '<header class="app-header">' +
      '<div class="app-header-left"><span class="app-brand"><span class="app-brand-mark">&bull;</span> Active Recall</span></div>' +
      '<nav class="app-nav" aria-label="Primary">' +
      navItem("home", "Home", "home", "#/home") +
      navItem("learn", "Learn", "learn", "#/learn") +
      navItem("review", "Review", "review", "#/history") +
      navItem("progress", "Progress", "progress", "#/progress") +
      "</nav>" +
      '<button type="button" class="icon-btn" id="themeToggle" title="Toggle theme" aria-label="Toggle light/dark theme">' +
      icon("theme") +
      "</button>" +
      "</header>" +
      '<main class="app-main">' +
      bodyHtml +
      "</main>" +
      '<nav class="app-tabbar" aria-label="Primary">' +
      '<div class="app-tabbar-inner">' +
      tabItem("home", "Home", "home", "#/home") +
      tabItem("learn", "Learn", "learn", "#/learn") +
      tabItem("review", "Review", "review", "#/history") +
      tabItem("progress", "Progress", "progress", "#/progress") +
      "</div></nav>" +
      "</div>"
    );
  }

  /* Focus-mode chrome used for Ready / Recall / Compare — the core
     read -> hide -> recall -> compare loop stays distraction-free: no
     sidebar, no nav, no analytics cards. */
  function focusShellHtml(crumbHtml, bodyHtml, exitHref) {
    return (
      '<div class="recall-shell">' +
      '<div class="recall-topbar">' +
      '<div class="crumb">' +
      crumbHtml +
      "</div>" +
      '<a class="icon-btn" href="' +
      exitHref +
      '" title="Exit" aria-label="Exit">' +
      icon("close") +
      "</a>" +
      "</div>" +
      '<div class="recall-main">' +
      bodyHtml +
      "</div>" +
      "</div>"
    );
  }

  function render() {
    var parts = parseHash();
    CURRENT_NAV = parts[0] === "learn" ? "learn" : parts[0] === "history" ? "review" : parts[0] === "progress" ? "progress" : "home";
    var screen = resolveScreen(parts);
    document.title = screen.title ? "Active Recall — " + screen.title : "Active Recall";
    root.innerHTML = screen.focus ? screen.html : shellHtml(screen.html);
    if (screen.mount) screen.mount();
    var themeBtn = document.getElementById("themeToggle");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
    window.scrollTo(0, 0);
  }

  /* ----------------------------------------------------------------- */
  /* Components (render functions) — reused across screens             */
  /* ----------------------------------------------------------------- */

  function ProgressIndicator(current, total) {
    var pct = total ? Math.round((current / total) * 100) : 0;
    return (
      '<div class="lesson-progress-row">' +
      "<span>Section " +
      current +
      " of " +
      total +
      "</span>" +
      '<div class="progress-track" style="width:120px" role="progressbar" aria-valuenow="' +
      pct +
      '" aria-valuemin="0" aria-valuemax="100">' +
      '<div class="progress-fill" style="width:' +
      pct +
      '%"></div>' +
      "</div></div>"
    );
  }

  function RatingPill(rating) {
    if (typeof rating !== "number") return '<span class="pill">Not yet rated</span>';
    var labels = { 1: "Poor", 2: "Okay", 3: "Good", 4: "Excellent" };
    return '<span class="pill pill-rating-' + rating + '">' + labels[rating] + "</span>";
  }

  function ReviewCard(note) {
    var ctx = Data.getLessonContext(note.lesson_id);
    var subjectName = ctx && ctx.subject ? ctx.subject.name : "";
    var topicName = ctx && ctx.topic ? ctx.topic.name : "";
    var lessonId = note.lesson_id;
    var sectionId = note.section_id;
    var detailHref = typeof note.self_rating === "number" ? "#/history/" + note.id : "#/compare/" + note.id;
    return (
      '<div class="review-card" data-note-id="' +
      note.id +
      '">' +
      '<div class="review-card-head">' +
      '<div><div class="pick-row-title">' +
      escapeHtml(subjectName) +
      "</div>" +
      '<div class="pick-row-sub">' +
      escapeHtml(topicName) +
      "</div></div>" +
      RatingPill(note.self_rating) +
      "</div>" +
      '<div class="review-card-meta"><span>Last recalled: ' +
      Data.daysAgo(note.updated_at) +
      "</span></div>" +
      '<div class="review-card-actions">' +
      '<a class="btn btn-ghost btn-sm" href="' +
      detailHref +
      '">View</a>' +
      '<button type="button" class="btn btn-primary review-again-btn" data-lesson-id="' +
      lessonId +
      '" data-section-id="' +
      sectionId +
      '">Review Again</button>' +
      "</div></div>"
    );
  }

  function wireReviewAgainButtons(container) {
    container.querySelectorAll(".review-again-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        navigate("#/recall/" + btn.dataset.lessonId + "/" + btn.dataset.sectionId);
      });
    });
  }

  /* ----------------------------------------------------------------- */
  /* Screens                                                            */
  /* ----------------------------------------------------------------- */

  var Screens = {};

  Screens.home = function () {
    var hour = new Date().getHours();
    var greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

    var due = Data.notesDueForReview();
    var weak = Data.weakTopics(3);

    /* "Continue Learning": the most recently touched in-progress lesson,
       falling back to the first lesson of the seed content on a fresh
       install so Home is never empty. */
    var lessons = Data.Table.list("lessons");
    var inProgress = lessons
      .map(function (lesson) {
        var sections = Data.getLessonSections(lesson.id);
        var read = Data.getReadSections(lesson.id);
        return { lesson: lesson, total: sections.length, read: read.length, sections: sections };
      })
      .filter(function (row) {
        return row.read > 0 && row.read < row.total;
      });
    var continueRow = inProgress[0];
    var startRow = null;
    if (!continueRow) {
      var untouched = lessons
        .map(function (lesson) {
          var sections = Data.getLessonSections(lesson.id);
          var read = Data.getReadSections(lesson.id);
          return { lesson: lesson, total: sections.length, read: read.length, sections: sections };
        })
        .filter(function (row) {
          return row.read === 0;
        });
      startRow = untouched[0];
    }

    var body =
      '<div class="stack">' +
      '<div><h1 class="page-title home-greeting">' +
      greeting +
      "</h1><p class=\"home-greeting-sub\">What do you want to study?</p></div>";

    body += '<div class="surface-card stack-sm">';
    body += '<h2 class="section-title">Today’s Review</h2>';
    if (due.length > 0) {
      body +=
        '<p class="text-muted">' +
        due.length +
        (due.length === 1 ? " recall is" : " recalls are") +
        ' ready to revisit.</p>' +
        '<a class="btn btn-primary" href="#/history">Start Review</a>';
    } else {
      body += '<p class="empty-note">Nothing due for review right now.</p>';
    }
    body += "</div>";

    if (continueRow || startRow) {
      var row = continueRow || startRow;
      var ctx = Data.getLessonContext(row.lesson.id);
      var pct = row.total ? Math.round((row.read / row.total) * 100) : 0;
      body +=
        '<div class="surface-card stack-sm">' +
        '<h2 class="section-title">' +
        (continueRow ? "Continue Learning" : "Start Learning") +
        "</h2>" +
        '<div class="crumb">' +
        (ctx && ctx.subject ? escapeHtml(ctx.subject.name) : "") +
        (ctx && ctx.topic ? " &rsaquo; " + escapeHtml(ctx.topic.name) : "") +
        "</div>" +
        '<div class="pick-row-title">' +
        escapeHtml(row.lesson.title) +
        "</div>" +
        (continueRow
          ? '<div class="progress-track"><div class="progress-fill" style="width:' +
            pct +
            '%"></div></div><p class="text-small text-muted">' +
            pct +
            "% complete</p>"
          : "") +
        '<a class="btn btn-primary" id="continueLearningLink">' +
        (continueRow ? "Continue" : "Start") +
        "</a>" +
        "</div>";
    }

    if (weak.length > 0) {
      body +=
        '<div>' +
        '<h2 class="section-title">Weak Topics</h2>' +
        '<div class="weak-topics">' +
        weak
          .map(function (w) {
            return '<span class="pill">' + escapeHtml(w.topic.name) + "</span>";
          })
          .join("") +
        "</div></div>";
    }

    body += "</div>";

    return {
      title: "Home",
      html: body,
      mount: function () {
        var link = document.getElementById("continueLearningLink");
        if (link) {
          var row = continueRow || startRow;
          var next = row.sections.find(function (s) {
            return row.read < 1 || Data.getReadSections(row.lesson.id).indexOf(s.id) === -1;
          });
          var target = next || row.sections[0];
          link.href = "#/lesson/" + row.lesson.id + "/section/" + target.id;
        }
      }
    };
  };

  Screens.subjects = function () {
    var subjects = Data.Table.list("subjects");
    var rows = subjects
      .map(function (subject) {
        var topicCount = Data.getTopicsForSubject(subject.id).length;
        return (
          '<a class="pick-row" href="#/learn/subject/' +
          subject.id +
          '">' +
          '<div><div class="pick-row-title">' +
          escapeHtml(subject.name) +
          "</div>" +
          '<div class="pick-row-sub">' +
          topicCount +
          (topicCount === 1 ? " topic" : " topics") +
          "</div></div>" +
          '<span class="pick-row-chevron">' +
          icon("chevron") +
          "</span></a>"
        );
      })
      .join("");
    return {
      title: "Learn",
      html:
        '<div class="stack">' +
        '<h1 class="page-title">Learn</h1>' +
        '<div class="pick-list">' +
        (rows || '<p class="empty-note">No subjects yet.</p>') +
        "</div></div>"
    };
  };

  Screens.topics = function (subjectId) {
    var subject = Data.Table.get("subjects", subjectId);
    var topics = Data.getTopicsForSubject(subjectId);
    var rows = topics
      .map(function (topic) {
        var lessonCount = Data.getLessonsForTopic(topic.id).length;
        return (
          '<a class="pick-row" href="#/learn/topic/' +
          topic.id +
          '">' +
          '<div><div class="pick-row-title">' +
          escapeHtml(topic.name) +
          "</div>" +
          '<div class="pick-row-sub">' +
          lessonCount +
          (lessonCount === 1 ? " lesson" : " lessons") +
          "</div></div>" +
          '<span class="pick-row-chevron">' +
          icon("chevron") +
          "</span></a>"
        );
      })
      .join("");
    return {
      title: subject ? subject.name : "Topics",
      html:
        '<div class="stack">' +
        '<div class="crumb"><a href="#/learn">Learn</a><span>&rsaquo;</span><strong>' +
        escapeHtml(subject ? subject.name : "") +
        "</strong></div>" +
        '<h1 class="page-title">' +
        escapeHtml(subject ? subject.name : "") +
        "</h1>" +
        '<div class="pick-list">' +
        (rows || '<p class="empty-note">No topics yet.</p>') +
        "</div></div>"
    };
  };

  Screens.lessons = function (topicId) {
    var topic = Data.Table.get("topics", topicId);
    var subject = topic ? Data.Table.get("subjects", topic.subject_id) : null;
    var lessons = Data.getLessonsForTopic(topicId);
    var rows = lessons
      .map(function (lesson) {
        var sections = Data.getLessonSections(lesson.id);
        var read = Data.getReadSections(lesson.id);
        var pct = sections.length ? Math.round((read.length / sections.length) * 100) : 0;
        var next = sections.find(function (s) {
          return read.indexOf(s.id) === -1;
        }) || sections[0];
        return (
          '<a class="pick-row" href="#/lesson/' +
          lesson.id +
          "/section/" +
          (next ? next.id : "") +
          '">' +
          '<div><div class="pick-row-title">' +
          escapeHtml(lesson.title) +
          "</div>" +
          '<div class="pick-row-sub">' +
          escapeHtml(lesson.description) +
          " &middot; " +
          lesson.estimated_minutes +
          " min" +
          (read.length ? " &middot; " + pct + "% complete" : "") +
          "</div></div>" +
          '<span class="pick-row-chevron">' +
          icon("chevron") +
          "</span></a>"
        );
      })
      .join("");
    return {
      title: topic ? topic.name : "Lessons",
      html:
        '<div class="stack">' +
        '<div class="crumb"><a href="#/learn">Learn</a><span>&rsaquo;</span>' +
        '<a href="#/learn/subject/' +
        (subject ? subject.id : "") +
        '">' +
        escapeHtml(subject ? subject.name : "") +
        "</a><span>&rsaquo;</span><strong>" +
        escapeHtml(topic ? topic.name : "") +
        "</strong></div>" +
        '<h1 class="page-title">' +
        escapeHtml(topic ? topic.name : "") +
        "</h1>" +
        '<div class="pick-list">' +
        (rows || '<p class="empty-note">No lessons yet.</p>') +
        "</div></div>"
    };
  };

  /* LessonViewer + LessonSection: one manageable unit of reading at a time */
  Screens.lessonSection = function (lessonId, sectionId) {
    var ctx = Data.getLessonContext(lessonId);
    var sections = Data.getLessonSections(lessonId);
    var section = Data.Table.get("lesson_sections", sectionId) || sections[0];
    var index = sections.findIndex(function (s) {
      return s.id === section.id;
    });

    var body =
      '<div class="stack">' +
      '<div class="crumb"><strong>' +
      escapeHtml(ctx && ctx.subject ? ctx.subject.name : "") +
      "</strong><span>&rsaquo;</span>" +
      escapeHtml(ctx && ctx.topic ? ctx.topic.name : "") +
      "</div>" +
      '<h1 class="page-title">' +
      escapeHtml(ctx && ctx.lesson ? ctx.lesson.title : "") +
      "</h1>" +
      ProgressIndicator(index + 1, sections.length) +
      '<div class="surface-card">' +
      '<h2 class="section-title" style="margin-bottom:14px">' +
      escapeHtml(section.title) +
      "</h2>" +
      '<p class="lesson-section-body">' +
      escapeHtml(section.content) +
      "</p>" +
      "</div>" +
      '<button type="button" class="btn btn-primary btn-block" id="finishReadingBtn">Finish Reading</button>' +
      "</div>";

    return {
      title: section.title,
      html: body,
      mount: function () {
        document.getElementById("finishReadingBtn").addEventListener("click", function () {
          Data.markSectionRead(lessonId, section.id);
          navigate("#/ready/" + lessonId + "/" + section.id);
        });
      }
    };
  };

  /* Transition prompt: read -> hide material -> recall */
  Screens.ready = function (lessonId, sectionId) {
    var ctx = Data.getLessonContext(lessonId);
    var section = Data.Table.get("lesson_sections", sectionId);
    var crumb =
      '<strong>' + escapeHtml(ctx && ctx.subject ? ctx.subject.name : "") + "</strong>" +
      "<span>&rsaquo;</span>" + escapeHtml(section ? section.title : "");
    var body =
      '<div class="prompt-panel">' +
      '<h1 class="section-title">You have finished reading.</h1>' +
      '<p class="text-muted">Now close the material and write everything you remember. Do not look back.</p>' +
      '<button type="button" class="btn btn-primary" id="startRecallBtn">Start Recall</button>' +
      '<a class="btn btn-ghost" href="#/lesson/' +
      lessonId +
      "/section/" +
      sectionId +
      '">Read it again</a>' +
      "</div>";
    return {
      title: "Ready to recall",
      focus: true,
      html: focusShellHtml(crumb, body, "#/lesson/" + lessonId + "/section/" + sectionId),
      mount: function () {
        document.getElementById("startRecallBtn").addEventListener("click", function () {
          navigate("#/recall/" + lessonId + "/" + sectionId);
        });
      }
    };
  };

  /* RecallEditor: distraction-free, write-from-memory only */
  Screens.recall = function (lessonId, sectionId) {
    var ctx = Data.getLessonContext(lessonId);
    var section = Data.Table.get("lesson_sections", sectionId);
    var crumb =
      '<strong>' + escapeHtml(ctx && ctx.subject ? ctx.subject.name : "") + "</strong>" +
      "<span>&rsaquo;</span>" + escapeHtml(ctx && ctx.topic ? ctx.topic.name : "");

    var body =
      '<h1 class="section-title">What do you remember?</h1>' +
      '<textarea class="recall-textarea" id="recallInput" placeholder="Write everything you remember, in your own words…" autofocus></textarea>' +
      '<div class="recall-meta"><span id="wordCount">0 words</span></div>' +
      '<div class="recall-actions"><button type="button" class="btn btn-primary" id="saveRecallBtn" disabled>Save Recall</button></div>';

    return {
      title: "Recall",
      focus: true,
      html: focusShellHtml(crumb, body, "#/lesson/" + lessonId + "/section/" + sectionId),
      mount: function () {
        currentSessionId = Data.startSession(lessonId, sectionId).id;
        var textarea = document.getElementById("recallInput");
        var wordCountEl = document.getElementById("wordCount");
        var saveBtn = document.getElementById("saveRecallBtn");
        textarea.focus();
        textarea.addEventListener("input", function () {
          var count = Data.wordCount(textarea.value);
          wordCountEl.textContent = count + (count === 1 ? " word" : " words");
          saveBtn.disabled = count === 0;
        });
        saveBtn.addEventListener("click", function () {
          var note = Data.saveRecall({
            lessonId: lessonId,
            topicId: ctx && ctx.topic ? ctx.topic.id : null,
            sectionId: sectionId,
            content: textarea.value,
            sessionId: currentSessionId
          });
          navigate("#/compare/" + note.id);
        });
      }
    };
  };

  /* RecallComparison + RecallRating */
  Screens.compare = function (noteId) {
    var note = Data.Table.get("recall_notes", noteId);
    if (!note) {
      navigate("#/home");
      return { title: "Compare", html: "" };
    }
    var section = Data.Table.get("lesson_sections", note.section_id);
    var ctx = Data.getLessonContext(note.lesson_id);
    var crumb =
      '<strong>' + escapeHtml(ctx && ctx.subject ? ctx.subject.name : "") + "</strong>" +
      "<span>&rsaquo;</span>" + escapeHtml(section ? section.title : "");

    var alreadyRated = typeof note.self_rating === "number";

    var body =
      '<div class="stack">' +
      '<div class="compare-block"><span class="eyebrow">Your Recall</span>' +
      '<p class="compare-text">' +
      escapeHtml(note.content) +
      "</p></div>" +
      '<hr class="divider">' +
      '<div class="compare-block"><span class="eyebrow">Original Material</span>' +
      '<p class="compare-text">' +
      escapeHtml(section ? section.content : "") +
      "</p></div>" +
      '<hr class="divider">' +
      '<div id="ratingArea">' +
      '<h2 class="section-title" style="margin-bottom:12px">How well did you remember?</h2>' +
      '<div class="rating-row">' +
      [1, 2, 3, 4]
        .map(function (r) {
          var labels = { 1: "Poor", 2: "Okay", 3: "Good", 4: "Excellent" };
          return (
            '<button type="button" class="rating-btn' +
            (note.self_rating === r ? " selected" : "") +
            '" data-rating="' +
            r +
            '">' +
            labels[r] +
            "</button>"
          );
        })
        .join("") +
      "</div></div>" +
      "</div>";

    return {
      title: "Compare",
      focus: true,
      html: focusShellHtml(crumb, body, "#/home"),
      mount: function () {
        var ratingArea = document.getElementById("ratingArea");
        function showSavedState(rating) {
          var nextHref = "#/home";
          var nextLabel = "Back to Home";
          if (ctx && ctx.lesson) {
            var sections = Data.getLessonSections(ctx.lesson.id);
            var read = Data.getReadSections(ctx.lesson.id);
            var next = sections.find(function (s) {
              return read.indexOf(s.id) === -1;
            });
            if (next) {
              nextHref = "#/lesson/" + ctx.lesson.id + "/section/" + next.id;
              nextLabel = "Next Section";
            } else {
              nextHref = "#/learn/topic/" + ctx.lesson.topic_id;
              nextLabel = "Back to Lessons";
            }
          }
          ratingArea.innerHTML =
            '<h2 class="section-title" style="margin-bottom:12px">How well did you remember?</h2>' +
            '<div class="rating-row">' +
            [1, 2, 3, 4]
              .map(function (r) {
                var labels = { 1: "Poor", 2: "Okay", 3: "Good", 4: "Excellent" };
                return (
                  '<button type="button" class="rating-btn' +
                  (rating === r ? " selected" : "") +
                  '" data-rating="' +
                  r +
                  '" disabled>' +
                  labels[r] +
                  "</button>"
                );
              })
              .join("") +
            "</div>" +
            '<div class="recall-actions" style="margin-top:16px"><a class="btn btn-primary" href="' +
            nextHref +
            '">' +
            nextLabel +
            "</a></div>";
        }
        if (alreadyRated) showSavedState(note.self_rating);
        ratingArea.addEventListener("click", function (e) {
          var btn = e.target.closest(".rating-btn");
          if (!btn || btn.disabled) return;
          var rating = parseInt(btn.dataset.rating, 10);
          Data.rateRecall(noteId, currentSessionId, rating);
          toast("Recall saved");
          showSavedState(rating);
        });
      }
    };
  };

  Screens.history = function () {
    var notes = Data.Table.list("recall_notes").sort(function (a, b) {
      return new Date(b.updated_at) - new Date(a.updated_at);
    });
    var due = Data.notesDueForReview();
    var dueIds = due.map(function (n) {
      return n.id;
    });
    var rest = notes.filter(function (n) {
      return dueIds.indexOf(n.id) === -1;
    });

    var body = '<div class="stack"><h1 class="page-title">Recall History</h1>';
    if (due.length) {
      body +=
        '<div><h2 class="section-title" style="margin-bottom:10px">Due for Review</h2>' +
        '<div class="stack-sm">' +
        due.map(ReviewCard).join("") +
        "</div></div>";
    }
    body +=
      '<div><h2 class="section-title" style="margin-bottom:10px">Your Recalls</h2>' +
      '<div class="stack-sm">' +
      (rest.map(ReviewCard).join("") || '<p class="empty-note">No recalls saved yet. Finish a lesson section to write your first one.</p>') +
      "</div></div></div>";

    return {
      title: "Recall History",
      html: body,
      mount: function () {
        wireReviewAgainButtons(root);
      }
    };
  };

  Screens.historyDetail = function (noteId) {
    var note = Data.Table.get("recall_notes", noteId);
    if (!note) {
      navigate("#/history");
      return { title: "Recall History", html: "" };
    }
    var section = Data.Table.get("lesson_sections", note.section_id);
    var ctx = Data.getLessonContext(note.lesson_id);
    var body =
      '<div class="stack">' +
      '<div class="crumb"><a href="#/history">Recall History</a><span>&rsaquo;</span><strong>' +
      escapeHtml(section ? section.title : "") +
      "</strong></div>" +
      '<h1 class="page-title">' +
      escapeHtml(section ? section.title : "") +
      "</h1>" +
      '<p class="text-muted">' +
      escapeHtml(ctx && ctx.subject ? ctx.subject.name : "") +
      " &middot; Last recalled " +
      Data.daysAgo(note.updated_at) +
      "</p>" +
      RatingPill(note.self_rating) +
      '<hr class="divider">' +
      '<div class="compare-block"><span class="eyebrow">Your Recall</span>' +
      '<p class="compare-text">' +
      escapeHtml(note.content) +
      "</p></div>" +
      '<hr class="divider">' +
      '<div class="compare-block"><span class="eyebrow">Original Material</span>' +
      '<p class="compare-text">' +
      escapeHtml(section ? section.content : "") +
      "</p></div>" +
      '<button type="button" class="btn btn-primary review-again-btn" data-lesson-id="' +
      note.lesson_id +
      '" data-section-id="' +
      note.section_id +
      '">Review Again</button>' +
      "</div>";
    return {
      title: section ? section.title : "Recall",
      html: body,
      mount: function () {
        wireReviewAgainButtons(root);
      }
    };
  };

  Screens.progress = function () {
    var averages = Data.averageRatingBySubject();
    var body =
      '<div class="stack">' +
      '<h1 class="page-title">Progress</h1>' +
      '<div class="surface-card stack-sm">' +
      '<h2 class="section-title">Average Recall Quality</h2>' +
      (averages.length
        ? averages
            .map(function (row) {
              var pct = Math.round((row.average / 4) * 100);
              return (
                '<div class="mastery-row">' +
                '<div class="mastery-row-head"><span>' +
                escapeHtml(row.subject.name) +
                "</span><span>" +
                row.average.toFixed(1) +
                " / 4</span></div>" +
                '<div class="progress-track"><div class="progress-fill" style="width:' +
                pct +
                '%"></div></div>' +
                "</div>"
              );
            })
            .join("")
        : '<p class="empty-note">Rate a few recalls to see your progress here.</p>') +
      "</div></div>";
    return { title: "Progress", html: body };
  };

  window.addEventListener("hashchange", render);
  render();
})();
