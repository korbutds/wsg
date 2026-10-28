'use strict';

// Russian UI strings. Same keys as en.js; the test suite checks that the sets match.
// Workspace files never use these: they stay English whatever the language is.

module.exports = {
  'cli.usage': `
wsg — Workspace Generation: задачные воркспейсы для агентов (Claude Code, Codex).

Один каталог на задачу: своя история сессий, своя память агента, правила,
подгружаемые по требованию, и репозитории внутри как git worktree.

  wsg new <слаг> [--title T] [--kind task|process] [--skill ИМЯ] [--ticket X] [--no-launch]
      создать воркспейс и запустить в нём агента с /wsg-setup
  wsg add <путь> [--worktree|--link|--reference] [--branch B] [--base REF] [--reset-to-base]
      [--target T] [--verify КОМАНДА] [--carry all|none|a,b] [--[no-]clone-node-modules]
      [--note ТЕКСТ] [--dry-run] [--ws СЛАГ|ПУТЬ]
      подключить источник к воркспейсу (по умолчанию — к тому, где ты сейчас)
  wsg remove <имя> [--delete-ignored] [--dry-run] [--ws СЛАГ|ПУТЬ]
      отключить источник: worktree (только чистый, ветка остаётся) или симлинк
  wsg refresh [--dry-run] [--ws СЛАГ|ПУТЬ]
      привести генерируемые части воркспейса к этой версии wsg
  wsg team <пресет> [--without РОЛЬ,...] [--dry-run] [--ws СЛАГ|ПУТЬ]
      добавить команду: карточки ролей и процесс, по сабагенту на роль для Claude Code
      (пресет: fullstack — pm, designer, frontend, backend, devops, reviewer)
  wsg check [путь|слаг]       проверить воркспейс на соответствие конвенциям
  wsg promote [слаг|путь] --skill ИМЯ
                              превратить задачу в процесс
  wsg guide [setup|advisor|teach]
                              напечатать гайд, по которому идёт агент: настройки, советника
                              или обучения роли команды практике
  wsg install-skills [--uninstall]
                              установить (или удалить) скиллы wsg-new и wsg-teach и агента
                              wsg-advisor для Claude Code и Codex
  wsg shell-init zsh          напечатать функцию перехода ws для eval
  wsg --where                 каталог установки (там лежит config.example)
  wsg --version | --help
  wsg help <команда>          параметры команды (или wsg <команда> --help)

Вид воркспейса: «задача» — один тикет и одна ветка, до мержа;
«процесс» — повторяемая инженерная процедура в скилле (релиз, обновление зависимостей).

Коды выхода: 0 — всё в порядке; 1 — проверка нашла ошибки или шаг не удался и откачен;
2 — неверный ввод (ничего не изменено); 130 — отменено по Ctrl+C (откачено).

Настройки: ~/.config/wsg/config (образец — config.example рядом с установкой).
Язык: WSG_LANG=en|ru в конфиге; без него — по локали.
Агент: WSG_AGENT в конфиге, его используют wsg new и ws; выбрать — ws --agent.
Файлы воркспейса всегда на английском.
`,
  'help.new': `
wsg new <слаг> [параметры]
  Создать воркспейс $WS_ROOT/<слаг> и запустить в нём агента на настройку
  (/wsg-setup в Claude Code). Нужен только слаг, а для процесса ещё --kind process:
  остальное спросит диалог настройки, прочие параметры лишь избавляют агента
  от вопроса.

  <слаг>               имя каталога: строчная латиница, цифры, дефисы
  --title T            название задачи по-человечески, заголовок AGENTS.md, README.md
                       и notes.md. Это не описание: «что и зачем» выясняется в диалоге.
                       По умолчанию — слаг, и агент предложит название получше
  --kind task|process  task (по умолчанию): один тикет и одна ветка, до мержа.
                       process: воркспейс повторяемой процедуры (релиз, обновление
                       зависимостей); в нём создаётся скилл /<скилл>, которым идёт каждый
                       прогон, а память и журнал прогонов копятся. Задаётся здесь: диалог
                       об этом не спрашивает, задача становится процессом только через promote
  --skill ИМЯ          имя скилла процесса; по умолчанию — слаг (для слага wsg-… нужно
                       своё). Только для процесса
  --ticket X           ключ или ссылка на тикет, пишется под заголовком; ключ становится
                       ссылкой, если в конфиге задан WSG_TRACKER_URL
  --no-launch          не запускать агента, а напечатать следующий шаг
`,
  'help.add': `
wsg add <путь> [параметры]
  Подключить к воркспейсу один источник. Все проверки идут до первого изменения;
  при сбое откатывается только этот источник.

  <путь>               репозиторий, его подкаталог или каталог вне git
  --worktree           git worktree со своей веткой: по умолчанию для корня репозитория
  --link               симлинк на общий checkout, для репозитория, который задача только
                       читает; всегда для подкаталога и в процессе
  --reference          симлинк на каталог вне git: спеки, выгрузки, макеты
  --branch B           ветка задачи. Существующая подключается как есть, ветка только
                       на origin продолжается
  --base REF           от чего начинается новая ветка; по умолчанию — origin/<target>
  --reset-to-base      начать существующую ветку заново от базы; старая голова
                       сохраняется в backup/…
  --target T           ветка, в которую пойдёт MR; по умолчанию — origin/HEAD
  --verify КОМАНДА     команда, которая проверяет работу (тесты), одной строкой; идёт в AGENTS.md
  --carry all|none|a,b игнорируемые файлы, которые скопировать из основного checkout
                       (.env, сертификаты): all (по умолчанию), none или список имён
  --[no-]clone-node-modules
                       склонировать node_modules из основного checkout (по умолчанию,
                       copy-on-write на macOS) или оставить для установки
  --note ТЕКСТ         пометка к источнику, видна рядом с ним в AGENTS.md
  --dry-run            напечатать план в JSON и ничего не менять
  --ws СЛАГ|ПУТЬ       воркспейс; по умолчанию — тот, где ты сейчас
`,
  'help.remove': `
wsg remove <имя> [параметры]
  Отключить источник: чистый worktree (ветка остаётся) или симлинк, вместе с его правилом
  и генерируемыми частями. Источник подключён не с теми флагами — remove, потом add.

  <имя>                имя источника в воркспейсе
  --delete-ignored     удалить и игнорируемые файлы, которых больше нигде нет; без флага
                       удаление останавливается и перечисляет их
  --dry-run            напечатать план в JSON и ничего не менять
  --ws СЛАГ|ПУТЬ       воркспейс; по умолчанию — тот, где ты сейчас
`,
  'help.refresh': `
wsg refresh [параметры]
  Привести генерируемые части воркспейса к этой версии wsg: текст между маркерами
  <!-- wsg:… -->, additionalDirectories в .claude/settings.json, указатель repo
  и mr-target-branch.txt. Остальное не трогается.

  --dry-run            напечатать в JSON файлы, которые изменятся
  --ws СЛАГ|ПУТЬ       воркспейс; по умолчанию — тот, где ты сейчас
`,
  'help.team': `
wsg team <пресет> [параметры]
  Добавить команду ролей: карточки и процесс в team/, по сабагенту Claude Code на роль
  и /wsg-feature в задачном воркспейсе. Только добавляет: существующий файл остаётся.

  <пресет>             fullstack: pm, designer, frontend, backend, devops, reviewer
  --without РОЛЬ,...   роли, которые не ставить, через запятую
  --dry-run            напечатать в JSON, что будет создано, оставлено и обновлено
  --ws СЛАГ|ПУТЬ       воркспейс; по умолчанию — тот, где ты сейчас
`,
  'help.check': `
wsg check [путь|слаг]
  Проверить воркспейс на соответствие конвенциям: ошибки, предупреждения, бюджет
  постоянного контекста. Код выхода 1, если нашлись ошибки.

  путь|слаг            воркспейс; по умолчанию — тот, где ты сейчас
`,
  'help.promote': `
wsg promote [слаг|путь] --skill ИМЯ
  Превратить задачу в процесс: источники, правила и память остаются; добавляются
  заготовка скилла и журнал с первым запуском. Обратного пути нет.

  слаг|путь            воркспейс; по умолчанию — тот, где ты сейчас
  --skill ИМЯ          скилл, которым запускается процедура (/<имя>); kebab-case, не wsg-…
`,
  'help.guide': `
wsg guide [setup|advisor|teach]
  Напечатать гайд, по которому идёт агент.

  setup                диалог настройки (по умолчанию)
  advisor              порядок работы wsg-advisor
  teach                обучение роли команды практике (/wsg-teach)
`,
  'help.install-skills': `
wsg install-skills [--uninstall]
  Установить скиллы wsg-new и wsg-teach и агента wsg-advisor для Claude Code
  (~/.claude или $CLAUDE_CONFIG_DIR) и агента wsg-advisor для Codex, если он есть.
  Перезаписывает только файлы, которые записал сам.

  --uninstall          удалить только свои файлы
`,
  'help.shell-init': `
wsg shell-init zsh
  Напечатать функцию перехода ws. Добавь в ~/.zshrc:
    eval "$(wsg shell-init zsh)"
`,
  'cli.shellUnsupported': 'функция ws написана на zsh, для {shell} её пока нет.\n  Сам wsg работает в любой оболочке.',
  'cli.cannotReadSettings': 'не удалось прочитать настройки: {msg}',
  'cli.windows': 'Windows пока не поддерживается: нужны git worktree и симлинки в POSIX-виде.\n  В WSL работает.',
  'cli.unknownCommand': 'неизвестная команда: {cmd} (см. --help)',
  'cli.unknownArg': 'неизвестный аргумент: {arg} (см. --help)',
  'cli.needsValue': '{arg} требует значения (см. --help)',
  'cli.noValue': '{arg} не принимает значения',
  'cli.extraArg': 'лишний аргумент: {arg} (см. --help)',
  'cli.done': 'Готово',
  'cli.next': 'Дальше:',
  'cli.cancelled': 'Отменено, ничего не создано.',
  'cli.newSlug': 'укажи слаг воркспейса: wsg new <слаг>',
  'cli.badKind': '--kind — это task или process, а не {kind}',
  'cli.skillForProcess': '--skill нужен только для --kind process',
  'cli.created': 'Создан {ws}: каркас, репозиториев пока нет',
  'cli.launching': 'Запускаю {agent}…',
  'cli.launchFailed': 'не удалось запустить {agent}: {msg}',
  'cli.nextWs': '  ws {slug}        потом набери /wsg-setup',
  'cli.tellAgent': '  и скажи агенту: Read SETUP.md and follow it',
  'cli.noAgent': '  агент не найден: задай WSG_AGENT в {file} или запусти своего в воркспейсе',
  'cli.addPath': 'укажи источник: wsg add <путь>',
  'cli.oneMode': 'выбери что-то одно: --worktree, --link или --reference',
  'cli.notInWorkspace': 'это не воркспейс wsg: запусти команду внутри него или передай --ws <слаг|путь>',
  'cli.noWorkspace': 'нет воркспейса {ws}',
  'cli.notWorkspace': '{ws} — не воркспейс wsg: в нём нет .claude/wsg.json. Создай воркспейс через wsg new',
  'cli.legacyWorkspace': '{ws} создан wsg 0.1: в нём нет .claude/wsg.json, и wsg не может понять, какие части генерируемые.\n  Подключи источники к нему вручную или создай новый воркспейс через wsg new.',
  'cli.added': 'Подключён {name}',
  'cli.restart': '  settings.json изменился: перезапусти сессию агента в этом воркспейсе, чтобы {path} стал доступен',
  'cli.addNext': '  Дальше: wsg check',
  'cli.addCancelled': 'Отменено, воркспейс в прежнем состоянии.',
  'cli.removeName': 'укажи источник: wsg remove <имя>',
  'cli.removed': 'Удалён {name}',
  'cli.refreshed': 'Обновлено: {list}',
  'cli.refreshNone': 'Генерируемые части в актуальном состоянии',
  'cli.refreshRestart': '  settings.json изменился: перезапусти сессию агента в этом воркспейсе',
  'cli.branchKept': '  ветка {branch} остаётся в {path}',
  'cli.teamWritten': {
    one: 'Команда {preset}: записан {n} файл',
    few: 'Команда {preset}: записано {n} файла',
    many: 'Команда {preset}: записано {n} файлов',
    other: 'Команда {preset}: записано {n} файла',
  },
  'cli.teamNone': 'Команда на месте: записывать нечего',
  'cli.teamKept': '  оставлен {file}: файл есть, не перезаписан',
  'cli.teamRestart': '  Перед тем как звать роли или /wsg-feature, начни новую сессию (ws {slug} или claude в воркспейсе): уже запущенная их не видит',
  'cli.teamNext': '  Дальше: /wsg-feature <что сделать> в Claude Code',
  'cli.teamNextProcess': '  Дальше: /{skill} — он ссылается на team/workflow.md',
  'cli.promoteSkill': 'укажи имя скилла: wsg promote [слаг|путь] --skill <имя>',
  'cli.guideTopic': 'гайда {topic} нет: есть {topics}',
  'cli.skillWritten': 'установлен {file}',
  'cli.skillUnchanged': 'уже актуален: {file}',
  'cli.skillRefused': '{file} уже есть, и его записал не wsg (нет маркера "generated by wsg"): не перезаписываю.\n  Убери его и запусти wsg install-skills снова.',
  'cli.skillRemoved': 'удалён {file}',
  'cli.skillAbsent': 'не установлен: {file}',
  'cli.skillSkipped': '  пропущен {file}: Codex здесь нет (нет CODEX_HOME, ~/.codex и codex в PATH)',
  'cli.skillNotOurs': '{file} записал не wsg (нет маркера "generated by wsg"): оставлен',

  'validate.required': 'Обязательно',
  'validate.kebab': 'Только строчные латинские буквы, цифры и дефисы',
  'validate.skillPrefix': 'префикс wsg- занят скиллами, которые пишет сам wsg',
  'validate.exists': '{path} уже существует',
  'validate.branchInvalid': '{b} — недопустимое имя ветки',
  'validate.branchBusy': '{b} уже выписана в другом worktree',
  'validate.branchConflict': 'конфликтует с существующей веткой {conflict}: ветки git — это пути',
  'validate.refNotFound': 'ссылка {ref} не найдена в {name}',

  'workspace.badSlug': 'слаг {slug}: {why}',
  'workspace.badSkill': 'имя скилла {name}: {why}',
  'workspace.badSkillFromSlug': 'скилл процесса называется по слагу, а {name} не подходит: {why}. Задай --skill <имя>',
  'workspace.outside': 'слаг {slug} ведёт за пределы {root}',
  'workspace.stateInvalid': 'не удалось прочитать {file}: {msg}',

  'add.noPath': 'не указан путь к источнику',
  'add.selfSource': '{path} — это сам воркспейс, а не источник',
  'add.insideSource': '{path} внутри воркспейса {ws}: источник лежит вне его',
  'add.containsSource': '{path} содержит воркспейс {ws}: подключить его — значит привязать воркспейс к самому себе',
  'add.multiline': '{flag} должен быть одной строкой',
  'add.markerValue': '{flag} не может содержать <!--: это читалось бы как маркер wsg',
  'add.backtick': '{flag} не может содержать обратную кавычку: команда показывается в `коде`',
  'add.badTarget': '--target {target} — недопустимое имя ветки',
  'add.targetUnknown': '--target: {target} нет ни в {name}, ни в origin — проверь имя',
  'add.renamed': 'в воркспейсе будет называться {name}: пробелы ломают импорты',
  'add.duplicatePath': 'этот источник уже подключён как {name}',
  'add.duplicateName': 'имя {name} уже занято источником {path}: в воркспейсе не может быть двух каталогов с одним именем',
  'add.taken': '{name} в воркспейсе уже есть',
  'add.notGit': '{path} не под git. Источник — это git-репозиторий; каталог с материалами для задачи подключается через --reference',
  'add.referenceIsGit': '{path} под git: подключи его через --link или --worktree, --reference — для каталогов вне git',
  'add.subdirWorktree': 'worktree делается только для всего репозитория: укажи его корень {top} или подключи этот каталог через --link',
  'add.subdirLink': 'часть git-репозитория {top} — подключаю симлинком; для worktree укажи корень репозитория',
  'add.processWorktree': 'у процесса нет постоянной ветки: его репозитории подключаются через --link, ветку на прогон делает скилл',
  'add.processLink': 'процесс: подключаю симлинком — у процесса нет постоянной ветки',
  'add.worktreeOnly': '{flag} применим только к worktree, а этот источник — {mode}',
  'add.referenceFirst': 'git-репозиторий ещё не подключён: без него настройка воркспейса не закончена',
  'add.branchRequired': 'worktree нужна ветка задачи: --branch <имя> по конвенции именования репозитория',
  'add.attachAsIs': 'ветка {branch} уже есть: подключаю как есть, её коммиты сохраняются',
  'add.diverged': 'ветка {branch} и origin/{branch} разошлись: {ahead} коммитов только здесь, {behind} только в origin — ничего не сливаю',
  'add.continuing': 'продолжаю {remote}: локальная ветка начинается оттуда и отслеживает её',
  'add.baseWithExisting': '--base применим только к новой ветке или вместе с --reset-to-base: {branch} уже есть и подключается как есть',
  'add.resetNew': '--reset-to-base применим к существующей ветке, а {branch} здесь новая',
  'add.remoteBase': '{remote} уже есть: новая ветка от {base} не включит её коммиты.\n  Убери --base, чтобы продолжить её, или добавь --reset-to-base, чтобы начать заново от {base}',
  'add.remoteReset': 'начинаю {branch} заново от {base}: коммиты {remote} не войдут',
  'add.branchReset': 'ветка {branch} уже есть: она будет сброшена на базу, текущая голова — в backup/…',
  'add.baseLocal': 'origin/{target} нет: ветвлюсь от локальной {target}',
  'add.carryUnknown': '--carry: {file} нет среди неотслеживаемых файлов, которые можно скопировать (см. --dry-run)',
  'add.nmMissing': 'в основном чекауте нет node_modules, клонировать нечего',

  'remove.unknown': 'источника {name} в этом воркспейсе нет (источники: {list})',
  'remove.dirty': 'в worktree {name} есть изменения, которых больше нигде нет — сначала закоммить, спрячь или удали их:\n{list}',
  'remove.ignored': 'в worktree {name} есть игнорируемые файлы, которых больше нигде нет (созданы там или скопированы wsg и с тех пор изменены), и git удалит их вместе с ним:\n{list}\n  Перенеси нужное, потом повтори команду с --delete-ignored',
  'remove.ignoredAppeared': 'в worktree {name} после проверки появились игнорируемые файлы, и git удалит их вместе с ним:\n{list}\n  Ничего не изменено; повтори команду',
  'remove.listFailed': 'worktree {name}: git не смог перечислить игнорируемые файлы ({why}), а git удалит их вместе с ним не глядя. Ничего не изменено',
  'remove.statusFailed': 'worktree {name}: git не смог перечислить изменения в нём ({why}), и они пропадут не глядя. Ничего не изменено',
  'remove.listTooLarge': 'worktree {name}: git перечисляет там файлов больше чем на 256 МиБ — слишком много для проверки, а git удалит их вместе с ним не глядя. Ничего не изменено.\n  Удали результаты сборки в нём вручную (сначала перенеси нужное), потом повтори команду',
  'remove.nmNotChecked': 'node_modules, который wsg склонировал в {name}, не проверяется: изменения внутри него удалятся вместе с worktree',
  'remove.more': '… и ещё {n}',
  'remove.worktreeFailed': 'git не удалил worktree {name}: {out}',
  'remove.notLink': '{name} — не тот симлинк, который сделал wsg: не удаляю',
  'remove.ruleKept': '{file} записал не wsg: оставляю',
  'remove.worktree': '  worktree {name} удалён',
  'remove.symlink': '  симлинк {name} удалён',

  'gen.cowApfsOnly': 'copy-on-write есть только на APFS',
  'gen.clonefileUnavailable': 'clonefile недоступен',
  'gen.sourceMissing': '{path} не существует',
  'gen.sourceNotDir': '{path} — не каталог: источник — это репозиторий или каталог',
  'gen.sourceReserved': 'источник не может называться {name}: воркспейс создаёт свой {name}',
  'gen.branchConflict': 'имя {branch} конфликтует с веткой {conflict}: ветки git — это пути',
  'gen.twoSources': 'два источника называются {name}',
  'gen.rollingBack': 'Создание прервано. Откатываю {ws}',
  'gen.addRollingBack': 'Подключение {name} прервано. Возвращаю {ws} в прежнее состояние',
  'gen.undoFailed': 'Шаг отката не удался: {msg}',
  'gen.worktreeRemoveFailed': 'Не удалось снять worktree {name}: {out}',
  'gen.branchLeftAtBase': 'Ветка {name} осталась на базе, прежняя голова — в {backup}: {out}',
  'gen.branchRestored': 'Ветка {name} возвращена на прежнюю голову',
  'gen.branchRestoredNoUpstream': 'Ветка {name} возвращена на прежнюю голову, но её upstream всё ещё база — проверь git branch -vv',
  'gen.branchKept': 'Ветка {name} оставлена: в ней есть коммиты поверх {base}',
  'gen.branchDeleted': 'Удалена созданная ветка {name}',
  'gen.branchDeleteFailed': 'Ветка {name} осталась, удалить не удалось: {out}',
  'gen.rollbackDone': 'Откат выполнен.',
  'gen.creating': 'Создаю {ws}',
  'gen.branchAppeared': 'ветка {branch} появилась уже после проверки: запусти wsg add снова',
  'gen.branchGone': 'ветка {branch} пропала уже после проверки: запусти wsg add снова',
  'gen.removeRollingBack': 'Удаление {name} прервано. Возвращаю {ws} в прежнее состояние',
  'gen.worktreeReadded': 'Worktree {name} снова на {branch}; файлы, скопированные при создании (.env, node_modules), не вернулись',
  'gen.symlinkOnPath': '{path} в {ws} — симлинк: запись {file} ушла бы за пределы воркспейса, ничего не изменено',
  'gen.ruleExists': '{file} уже есть, и его записал не wsg: перенеси свои заметки и запусти команду снова',
  'gen.backupFailed': 'не удалось сохранить бэкап ветки {branch} как {bk}: {out}\n  создание прервано, чтобы не сбросить существующую ветку',
  'gen.backup': '  бэкап существующей ветки: {bk}',
  'gen.worktree': '  worktree {name} → {branch}',
  'gen.notCopied': '  не скопирован: {file} — {why}',
  'gen.copied': {
    one: '  скопирован {n} файл вне git из {total}',
    few: '  скопировано {n} файла вне git из {total}',
    many: '  скопировано {n} файлов вне git из {total}',
    other: '  скопировано {n} файла вне git из {total}',
  },
  'gen.nmTracked': '  node_modules отслеживается git и уже есть в worktree — не клонирую',
  'gen.nmCloning': '  клонирую node_modules (copy-on-write)...',
  'gen.nmCloned': '  node_modules склонирован, реально занято: {mb} МБ',
  'gen.nmVersions': '  версии совпадают с основным чекаутом; после смены веток — install',
  'gen.nmNotCopied': '  {reason} — node_modules не скопирован, нужен install',
  'gen.symlink': '  симлинк {name} → {path}',
  'gen.repoNamed': 'источник называется repo — указатель repo не создаю, он бы его затёр',
  'gen.notAFile': '{path} в {ws} — не обычный файл (симлинк?): wsg записал бы за его пределы',
  'gen.markerBroken': '{file}: у блока <!-- wsg:{name} --> открывающих маркеров — {opens}, закрывающих — {closes}, или они не по порядку.\n  Оставь ровно одну пару (или удали обе, и wsg добавит её заново) и запусти команду снова',
  'gen.markerIndented': '{file}: в строке {line} маркер блока <!-- wsg:{name} --> стоит с отступом, а пары с начала строки нет. wsg пишет свои маркеры с начала строки.\n  Верни пару в начало строки (или убери пример в блок кода) и запусти команду снова',
  'gen.fenceOpen': '{file}: блок кода, открытый в строке {line}, не закрыт, и маркеры wsg после него читаются как код.\n  Закрой его через {fence}, потом повтори команду',
  'gen.markerRestored': '{file}: маркеров <!-- wsg:{name} --> не было — блок добавлен заново',
  'gen.blockAdded': '{file}: добавлен блок <!-- wsg:{name} --> (новый в wsg {version})',
  'gen.fileMissing': '{file} нет — его генерируемая часть не обновлена',
  'gen.settingsInvalid': '{file} — невалидный JSON ({msg}): сначала исправь его, wsg его не перезаписывает',

  'team.noPreset': 'укажи пресет: wsg team <пресет> (есть: {presets})',
  'team.badPreset': 'нет пресета {preset}: есть — {presets}',
  'team.badRole': '--without: нет роли {role}; роли — {roles}',
  'team.noRoles': '--without не оставляет ни одной роли {preset}',
  'team.stateInvalid': '{file}: "team" — не { preset, roles } с именами ролей в kebab-case; сначала исправь вручную',
  'team.notADir': '{path} в {ws} — не каталог: wsg team пишет в него свои файлы',
  'team.skillMissing': '{file} нет — ссылка на team/workflow.md не добавлена',
  'team.rollingBack': 'Добавление команды прервано. Возвращаю {ws} в прежнее состояние',

  'lock.busy': 'в этом воркспейсе уже идёт другая команда wsg (pid {pid}, с {time}): дождись её.\n  Если она не идёт, удали {file}',
  'lock.stale': 'устаревшая блокировка {file} (процесса {pid} нет): забираю её',

  'promote.noWorkspace': 'нет воркспейса {ws}',
  'promote.notWorkspace': '{ws} не похож на воркспейс wsg: нет .claude/ws-kind',
  'promote.alreadyProcess': 'это уже процесс',
  'promote.head': 'Задача -> процесс: {ws}',
  'promote.intro': 'Источники, правила и память остаются. Появятся скилл процедуры и журнал прогонов.',
  'promote.symlink': '{path} в {ws} — симлинк: promote записал бы за пределы воркспейса',
  'promote.skillExists': 'скилл {skill} уже есть — не перезаписываю',
  'promote.skillCreated': '  создан скилл: .claude/skills/{skill}/SKILL.md',
  'promote.journalExists': 'journal.md уже есть — не перезаписываю',
  'promote.journalCreated': '  создан journal.md с первым прогоном',
  'promote.kindSwitched': '  вид переключён на процесс',
  'promote.sectionAdded': '  в AGENTS.md добавлен раздел «How it runs»',
  'promote.hasWorktrees': 'в воркспейсе есть worktree: {list}',
  'promote.worktreesHint': '  У процесса нет постоянной ветки — ветку прогона создаёт скилл. Worktree можно\n  оставить рабочей копией, но проверь, не мешает ли его закреплённая ветка.\n  Заменить на симлинк: git -C <репо> worktree remove <путь> && ln -s <репо> <путь>',
  'promote.team': '  В воркспейсе есть команда: запусти wsg team {preset}, чтобы /{skill} ссылался на team/workflow.md.\n  .claude/skills/wsg-feature/ остаётся; удали его, если процессу он не нужен.',
  'promote.next': '  Заполни шаги в .claude/skills/{skill}/SKILL.md и выводы в journal.md.\n  Дальше прогон вызывается так: /{skill} <о чём этот прогон>',

  'ws.state.noBranch': '(без ветки)',
  'ws.state.rebase': 'РЕБЕЙЗ НЕ ЗАВЕРШЁН',
  'ws.state.detached': 'detached HEAD',
  'ws.noAgent': 'агент не настроен: добавь в {WSG_CONFIG} строку WSG_AGENT="claude" (или свою команду)',
  'ws.setup.question': 'Какой командой запускать агента в воркспейсе? Спрошу один раз и запишу в {WSG_CONFIG}.',
  'ws.setup.custom': '  или введи свою команду целиком, например: gemini --yolo',
  'ws.pick.noOption': 'варианта {ans} нет — агент не запущен, спрошу в следующий раз',
  'ws.pick.nothing': 'ничего не выбрано — агент не запущен, спрошу в следующий раз',
  'ws.saved': 'записано: WSG_AGENT={q} в {WSG_CONFIG}. Сменить: ws --agent',
  'ws.list.title': 'Задачные воркспейсы',
  'ws.list.process': 'процесс',
  'ws.list.task': 'задача',
  'ws.list.sessions': 'сессий',
  'ws.list.runs': 'прогонов',
  'ws.list.shared': '(общий чекаут)',
  'ws.list.create': 'создать: wsg new <slug> · сменить агента: ws --agent',
  'ws.jump.ambiguous': 'неоднозначно: {list}',
  'ws.jump.none': "нет воркспейса '{slug}'. Список: ws",
  'ws.agent.nothingToRun': 'в WSG_AGENT из {WSG_CONFIG} нечего запускать',
};
