# loops

A colorful, interactive CLI that turns **Claude Code** or **Codex** into a personal tutor. It maps a topic, surveys it broadly, then takes you deep one area at a time, and it builds a folder of markdown notes with diagrams, equations and figures as you go.

```bash
npm i -g learn-loops
loops
```

Requires Node 20+ and either the `claude` or `codex` CLI installed and logged in (`npm i -g @anthropic-ai/claude-code` or `npm i -g @openai/codex`). If neither is found, `loops` says so and shows how to install one; if your saved tutor is missing but the other is present, it falls back to that one. If `loops` isn't found after install, add npm's global bin folder to your `PATH` (`npm prefix -g`, then `<that>/bin`).

## How it teaches

1. **Profile first**: the first run asks how you learn (examples vs. theory, diagrams, tone, quiz difficulty, Socratic or not, session length) and tailors every prompt.
2. **Launch screen**: each time you start, a quick energy/time check-in, then reopen a topic you've started or begin something new.
3. **Brain dump**: you write what you already know, which activates prior knowledge and sets the starting level.
4. **Map**: the whole territory as areas, concepts and a prerequisite graph (`map.md`, mermaid mindmap + flowchart, also drawn in the terminal).
5. **Survey**: a short lesson per area, so you get the basic idea of everything before depth.
6. **Deep dive**: you pick an area; it plans 4-7 lessons that build on each other, each with worked examples and figures.
7. **Every lesson**: guess first, read a small chunk, "explain it differently" on demand, predict-then-reveal, quiz with confidence ratings, then an **explain-it-in-your-own-words** teach-back to a persona (a curious 12-year-old, a skeptical expert...) who asks a follow-up.
8. **Think deeper**: trade-offs, failure modes, scale and second-order effects, with push-back, rotating through different lenses; an end-of-area **application challenge** with no single right answer.
9. **When you're stuck**: a short diagnosis finds the mental model that's wrong, re-teaches that, and re-tests it.
10. **Remembering**: SM-2 spaced repetition, a warm-up before each session, interleaved mixed quizzes (weakest first, confident mistakes first), a **mistake journal**, and a **streak**.

Lesson explanations type out gradually so you can read along. Press **Space** to pause/resume or **Enter** to show the rest immediately. Tables, equations, diagrams, figures, and code appear as complete blocks; questions and menus stay immediate. Set `LOOPS_TYPE_DELAY=15` for faster typing (milliseconds per character), or `LOOPS_TYPE_DELAY=0` to turn it off. Redirected/piped output always prints immediately.

## Equations, physics diagrams and plots

Technical lessons use real typesetting, not ASCII approximations:

- **Equations** are written in LaTeX and rendered with [MathJax](https://www.mathjax.org) (physics, ams, mhchem and cancel packages: `\ket{}`, `\pdv{}{}`, `\vb{}`, `\ce{}`), then rasterised with [resvg](https://github.com/RazrFalcon/resvg). No browser or LaTeX install needed.
- **Physical diagrams** (free-body, circuits, optics, fields) are drawn as SVG by the tutor, validated and sanitised, then shown inline.
- **Function plots** are exact: the tutor supplies expressions, [mathjs](https://mathjs.org) evaluates them, and `loops` draws the chart.
- **Inline display** works in iTerm2, WezTerm, Kitty, Ghostty and VS Code's terminal. Elsewhere you get a Unicode fallback: stacked fractions, roots, sums and bra-kets for equations, braille line art for plots. SVG diagrams need an image-capable terminal or the saved file.
- Saved notes keep `$$TeX$$` (rendered by GitHub, VS Code and Obsidian) and write each figure to `figures/*.svg` with a normal image link.
- Flowcharts, sequence, state and class diagrams (mermaid) are drawn in the terminal with [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid).

Override detection with `LOOPS_IMAGES=iterm|kitty|off`.

## Commands

```
loops               interactive menu (check-in, then reopen or start new)
loops new [topic]   start a new topic
loops continue      resume
loops review        review due flashcards
loops quiz          interleaved mixed quiz
loops mistakes      your mistake journal
loops streak        your streak
loops map           a topic's map and prerequisite diagram
loops topics        progress overview
loops profile       edit your learner profile
```

## Where things live

```
~/Learning/<folder>/<topic>/
  README.md  map.md  mistakes.md  topic.json
  survey/<area>.md
  deep/<area>/01-<lesson>.md  challenge.md
  figures/*.svg
```

Your profile and streak live in `~/.config/loops/`.
### Billing safety

`loops` runs the CLIs under your subscription login and strips `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and similar variables from their environment, so you aren't billed per token by accident. A CLI signed in with an API key (or Bedrock/Vertex) is refused unless you set `LOOPS_ALLOW_API_BILLING=1`. If your tutor fails (usage limit, outage), `loops` automatically tries the other one.

It **can't** see your account's "extra usage" (Claude) or credits (ChatGPT/Codex) settings, because neither CLI exposes them. If you don't want overage charges, turn those off in your account settings.

Env: `LOOPS_HOME`, `LOOPS_PROVIDER=claude|codex`, `LOOPS_ALLOW_API_BILLING=1`, `LOOPS_IMAGES`, `LOOPS_TYPE_DELAY`, `NO_COLOR`.
