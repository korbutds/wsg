'use strict';

// Russian UI strings. Same keys as en.js; the test suite checks that the sets match.
// Workspace files never use these: they stay English whatever the language is.

module.exports = {
  'cli.usage': `
wsg — Workspace Generation: задачные воркспейсы для агентов (Claude Code, Codex).

Один каталог на задачу: своя история сессий, своя память агента, правила,
подгружаемые по требованию, и репозитории внутри как git worktree.

  wsg new <слаг> [--title T] [--kind task|process|epic] [--skill ИМЯ] [--ticket X]
      [--epic E] [--sources a,b|none] [--dry-run] [--json] [--no-launch]
      создать воркспейс и запустить в нём агента с /wsg-setup
      (--epic E: задача внутри эпика E)
  wsg add <путь> [--worktree|--link|--reference] [--branch B] [--base REF] [--reset-to-base]
      [--target T] [--verify КОМАНДА] [--carry all|none|a,b] [--[no-]clone-node-modules]
      [--note ТЕКСТ] [--branch-template T] [--dry-run] [--json] [--ws СЛАГ|ПУТЬ]
      подключить источник к воркспейсу (по умолчанию — к тому, где ты сейчас)
  wsg remove <имя> [--delete-ignored] [--dry-run] [--json] [--ws СЛАГ|ПУТЬ]
      отключить источник: worktree (только чистый, ветка остаётся) или симлинк
  wsg refresh [--dry-run] [--ws СЛАГ|ПУТЬ]
      привести генерируемые части воркспейса к этой версии wsg
  wsg team <пресет> [--without РОЛЬ,...] [--dry-run] [--ws СЛАГ|ПУТЬ]
      добавить команду: карточки ролей и процесс, по сабагенту на роль для Claude Code
      (пресет: fullstack — pm, designer, frontend, backend, devops, reviewer)
  wsg check [путь|слаг] [--json]
                              проверить воркспейс на соответствие конвенциям
  wsg list [--json]           все воркспейсы в WS_ROOT, задачи эпика под ним
  wsg status <задача> [open|review|done] [--dry-run] [--json]
                              показать статус задачи или задать его
  wsg close <задача> [--dry-run] [--json]
                              отметить задачу выполненной: wsg status <задача> done
  wsg context add <url|путь> [--id ID] [--title T] [--desc D] [--dry-run] [--json] [--ws E]
  wsg context note <id> (--text T | --from ФАЙЛ|-) [--title T] [--desc D] [--replace] [...]
  wsg context remove <id> [...]       wsg context list [--json] [--ws E]
      контекст эпика: файлы, заметки и ссылки, которые его задачи открывают по надобности
  wsg promote [слаг|путь] --skill ИМЯ
                              превратить задачу в процесс
  wsg guide [setup|advisor|teach|epic]
                              напечатать гайд, по которому идёт агент: настройки, советника,
                              обучения роли команды практике или работы в эпике
  wsg install-skills [--uninstall]
                              установить (или удалить) скиллы wsg-new и wsg-teach и агента
                              wsg-advisor для Claude Code и Codex
  wsg shell-init zsh          напечатать функцию перехода ws для eval
  wsg --where                 каталог установки (там лежит config.example)
  wsg --version | --help
  wsg help <команда>          параметры команды (или wsg <команда> --help)

Вид воркспейса: «задача» — один тикет и одна ветка, до мержа;
«процесс» — повторяемая инженерная процедура в скилле (релиз, обновление зависимостей);
«эпик» — один эпик трекера: база знаний, его репозитории и задачи внутри него.

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
  (/wsg-setup в Claude Code). Нужен только слаг, а для процесса или эпика ещё --kind:
  остальное спросит диалог настройки, прочие параметры лишь избавляют агента
  от вопроса.

  <слаг>               имя каталога: строчная латиница, цифры, дефисы
  --title T            название задачи по-человечески, заголовок AGENTS.md, README.md
                       и notes.md. Это не описание: «что и зачем» выясняется в диалоге.
                       По умолчанию — слаг, и агент предложит название получше
  --kind task|process|epic
                       task (по умолчанию): один тикет и одна ветка, до мержа.
                       process: воркспейс повторяемой процедуры (релиз, обновление
                       зависимостей); в нём создаётся скилл /<скилл>, которым идёт каждый
                       прогон, а память и журнал прогонов копятся.
                       epic: один воркспейс на эпик трекера — база знаний, которую читают
                       его задачи, его репозитории и сами задачи, создаваемые внутри.
                       Задаётся здесь: диалог об этом не спрашивает, задача становится
                       процессом только через promote
  --skill ИМЯ          имя скилла процесса; по умолчанию — слаг (для слага wsg-… нужно
                       своё). Только для процесса
  --ticket X           ключ или ссылка на тикет, пишется под заголовком; ключ становится
                       ссылкой, если в конфиге задан WSG_TRACKER_URL
  --epic E             задача эпика E (слаг в WS_ROOT): создаётся в $WS_ROOT/E/<слаг>,
                       её AGENTS.md ссылается на knowledge.md и tasks.md эпика и рендерит
                       Owner rules эпика; tasks.md эпика её перечисляет.
                       Из текущего каталога не берётся никогда
  --sources a,b|none   с --epic: какие источники эпика берёт задача — worktree на ветке,
                       которую ей даёт шаблон эпика, или ссылку как есть. По умолчанию —
                       источник с шаблоном ветки, если он у эпика ровно один, иначе никакие
  --dry-run            напечатать план в JSON (состояние задачи, план каждого источника)
                       и ничего не менять
  --json               напечатать один JSON-документ — результат или ошибку — и больше
                       ничего в stdout; с --dry-run план внутри него. Агента не запускает
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
  --branch-template T  только в эпике: ветка, на которой каждая задача эпика получает
                       worktree, с {slug} и/или {ticket}, например alice/task/{slug}/{ticket}.
                       Без него репозиторий подключается в каждую задачу ссылкой как есть
  --dry-run            напечатать план в JSON и ничего не менять
  --json               напечатать один JSON-документ — результат или ошибку — и больше
                       ничего в stdout; с --dry-run план внутри него
  --ws СЛАГ|ПУТЬ       воркспейс; по умолчанию — тот, где ты сейчас

  В эпике репозиторий всегда подключается ссылкой: --worktree, --branch и --reset-to-base
  отклоняются, а --base, --carry и --[no-]clone-node-modules описывают worktree задач,
  поэтому нужен --branch-template.

  В задаче эпика wsg add <имя> берёт источник эпика с этим именем: worktree на ветке,
  которую задаче даёт его шаблон, или ссылку как есть, с target, verify, note и
  умолчаниями эпика; заданный флаг важнее. ./<имя> — это путь.
`,
  'help.remove': `
wsg remove <имя> [параметры]
  Отключить источник: чистый worktree (ветка остаётся) или симлинк, вместе с его правилом
  и генерируемыми частями. Источник подключён не с теми флагами — remove, потом add.

  <имя>                имя источника в воркспейсе
  --delete-ignored     удалить и игнорируемые файлы, которых больше нигде нет; без флага
                       удаление останавливается и перечисляет их
  --dry-run            напечатать план в JSON и ничего не менять
  --json               напечатать один JSON-документ — результат или ошибку — и больше
                       ничего в stdout; с --dry-run план внутри него
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
  Не в эпике: запускай в задаче эпика.

  <пресет>             fullstack: pm, designer, frontend, backend, devops, reviewer
  --without РОЛЬ,...   роли, которые не ставить, через запятую
  --dry-run            напечатать в JSON, что будет создано, оставлено и обновлено
  --ws СЛАГ|ПУТЬ       воркспейс; по умолчанию — тот, где ты сейчас
`,
  'help.check': `
wsg check [путь|слаг] [--json]
  Проверить воркспейс на соответствие конвенциям: ошибки, предупреждения, бюджет
  постоянного контекста. Код выхода 1, если нашлись ошибки.

  путь|слаг            воркспейс; по умолчанию — тот, где ты сейчас
  --json               напечатать один JSON-документ — отчёт по разделам и счётчики —
                       и больше ничего в stdout; нашлись ошибки: ok false, код 1. Каждая
                       строка — пункт своего раздела: ok, warn, fail или info для заметки;
                       предупреждения лежат там, а не в warnings конверта
`,
  'help.list': `
wsg list [--json]
  Показать все воркспейсы в WS_ROOT: эпики, задачи и процессы, задачи эпика — под ним,
  с видом, статусом задачи ([review], [done дата]), тикетом и названием. Воркспейс
  wsg 0.1 и воркспейс, чьё состояние не читается, тоже в списке — с тем, что не так.
  Только читает, git не запускает.

  --json               напечатать один JSON-документ — воркспейсы с состоянием, источниками
                       и каталогами, нужными сессии, — и больше ничего в stdout
`,
  'help.status': `
wsg status <задача> [open|review|done] [параметры]
  Показать статус задачи или процесса: open, review или done (с датой закрытия).
  Со статусом — задать его: разрешён любой переход, а тот же статус ничего не меняет.
  Меняются только .claude/wsg.json и, в задаче эпика, блок задач в tasks.md эпика;
  заметки, знания, ветки и worktree не трогаются. Переход в done предупреждает
  о незакоммиченной или незапушенной работе и о записях, оставшихся в «## For the epic»
  в notes.md, но из-за них не отказывает. done ставит сессия эпика или владелец;
  сессия самой задачи ставит review.

  <задача>             задача: слаг, <эпик>/<задача> или путь; указывается всегда
  open|review|done     статус, который задать; без него статус печатается
  --dry-run            напечатать план в JSON и ничего не менять
  --json               напечатать один JSON-документ — результат или ошибку — и больше
                       ничего в stdout; с --dry-run план внутри него
`,
  'help.close': `
wsg close <задача> [параметры]
  Отметить задачу или процесс выполненными: то же, что wsg status <задача> done, с теми же
  предупреждениями и тем же результатом. Ничего не мержится, не пушится и не удаляется.

  <задача>             задача: слаг, <эпик>/<задача> или путь
  --dry-run            напечатать план в JSON и ничего не менять
  --json               напечатать один JSON-документ — результат или ошибку — и больше
                       ничего в stdout; с --dry-run план внутри него
`,
  'help.context': `
wsg context add <url|путь> [параметры]
wsg context note <id> (--text T | --from ФАЙЛ | --from -) [параметры]
wsg context remove <id> [параметры]
wsg context list [--json] [--ws СЛАГ|ПУТЬ]
  Контекст эпика: файлы, заметки и ссылки, которые могут понадобиться его задачам.
  AGENTS.md эпика и каждой задачи получает их индекс, строка на элемент, в блоке
  <!-- wsg:epic-context -->; агент открывает элемент, только когда работа касается
  его темы. Изменение сразу рендерится во все задачи эпика: занятая задача попадает
  в отчёт и догоняет при следующем wsg refresh, выполненная остаётся как есть.
  В этой версии — только для эпика.

  add <url|путь>       http(s)-адрес сохраняется как ссылка; файл копируется в context/
                       (файл, который уже лежит в context/, вносится как есть); каталог
                       не принимается: подключи его через wsg add <путь> --reference
  note <id>            записать заметку в context/notes/<id>.md
  remove <id>          убрать элемент из индекса; файл, скопированный wsg, и заметка
                       удаляются из context/, файл, лежавший там раньше, остаётся
  list                 элементы и размер блока индекса, который несёт каждая задача
  --id ID              id элемента, kebab-case; по умолчанию — из имени файла или адреса
  --title T            одна строка, не длиннее 200 символов; по умолчанию — имя файла,
                       адрес или id
  --desc D             одна строка, не длиннее 200 символов: для чего элемент
  --text T             текст заметки
  --from ФАЙЛ|-        текст заметки из файла или, с -, из stdin
  --replace            переписать существующую заметку (и её заголовок и описание, если заданы)
  --discard-edits      убрать или переписать файл или заметку, даже если их правили руками
                       после записи wsg; без него — отказ
  --dry-run            напечатать план в JSON и ничего не менять
  --json               напечатать один JSON-документ — результат или ошибку — и больше
                       ничего в stdout; с --dry-run внутри него план
  --ws СЛАГ|ПУТЬ       эпик; по умолчанию — тот, где ты сейчас

  Ограничения: файл больше 1 МиБ — предупреждение, больше 20 МиБ — отказ; блок индекса
  больше 2 КиБ — предупреждение, больше 4 КиБ — отказ. Бинарный файл (PDF, картинка)
  копируется как есть и помечается: Claude Code его читает, другие агенты могут не прочесть.
`,
  'help.mcp': `
wsg mcp add <имя> [--env A,B=значение] -- <команда> [аргументы...]
wsg mcp add <имя> --url URL [--bearer-env VAR]
wsg mcp remove <имя> [параметры]
wsg mcp disable <имя> [параметры]
wsg mcp enable <имя> [параметры]
wsg mcp list [--json] [--ws СЛАГ|ПУТЬ]
  MCP-серверы эпика для Claude Code. Серверы эпика попадают в <эпик>/.mcp.json,
  который находят сессии в эпике и в каждой его задаче, и включаются по имени
  в .claude/settings.json каждого воркспейса; глобальный сервер, который эпик
  выключает, там запрещён по имени. Собственные записи владельца в обоих файлах
  остаются. Изменение сразу рендерится во все задачи эпика: занятая задача попадает
  в отчёт и догоняет при следующем wsg refresh, выполненная остаётся как есть.
  В этой версии — только эпик и только Claude Code. Запущенные сессии сохраняют
  свои серверы: перезапусти их.

  add <имя>            сервер, который запускает команда после --, или http-сервер
                       (--url); имя — буквы, цифры, - и _
  remove <имя>         убрать сервер эпика из .mcp.json и настроек
  disable <имя>        выключить глобальный сервер в эпике и его задачах: имя из
                       пользовательского конфига или сервер плагина plugin:<плагин>:<сервер>
  enable <имя>         включить его обратно
  list                 серверы эпика, выключенные, серверы пользователя (только имена)
                       и переменные, которых нет в этом шелле
  --env A,B=значение   переменные сервера: A по ссылке — \${A} в .mcp.json, берётся из
                       окружения, где работает агент; B=значение — литерал, отказ для
                       имени, похожего на секрет (TOKEN, KEY, SECRET, PASSWORD, AUTH, ...);
                       без запятых в значении
  --url URL            http(s) MCP-сервер
  --bearer-env VAR     переменная с токеном http-сервера: уходит как
                       Authorization: Bearer \${VAR}
  --agent claude       агент; codex пока не поддерживается
  --dry-run            напечатать план в JSON и ничего не менять
  --json               напечатать один JSON-документ — результат или ошибку — и больше
                       ничего в stdout; с --dry-run внутри него план; переменные только
                       по имени, никогда со значением
  --ws СЛАГ|ПУТЬ       эпик; по умолчанию — тот, где ты сейчас

  Секреты в файлы не попадают: экспортируй их в шелле (или в окружении приложения)
  и передавай имена. Токен в аргументе или адресе — предупреждение: .mcp.json читает
  агент каждой задачи. В терминале серверы задачи — "Pending approval", пока её папке
  не доверятся, один раз на каталог задачи. Сервер со входом через OAuth: один раз
  авторизуй его в сессии в терминале (/mcp).
`,
  'help.promote': `
wsg promote [слаг|путь] --skill ИМЯ
  Превратить задачу в процесс: источники, правила и память остаются; добавляются
  заготовка скилла и журнал с первым запуском. Обратного пути нет.
  Не для эпика и его задач.

  слаг|путь            воркспейс; по умолчанию — тот, где ты сейчас
  --skill ИМЯ          скилл, которым запускается процедура (/<имя>); kebab-case, не wsg-…
`,
  'help.guide': `
wsg guide [setup|advisor|teach|epic]
  Напечатать гайд, по которому идёт агент.

  setup                диалог настройки (по умолчанию)
  advisor              порядок работы wsg-advisor
  teach                обучение роли команды практике (/wsg-teach)
  epic                 работа в эпике: начало, закрытие и синхронизация его задач
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
  'cli.badKind': '--kind — это task, process или epic, а не {kind}',
  'cli.skillForProcess': '--skill нужен только для --kind process',
  'cli.created': 'Создан {ws}: каркас, репозиториев пока нет',
  'cli.noEpic': 'нет эпика {ws}',
  'cli.epicOutsideRoot': '{ws} не в WS_ROOT ({root}): задача эпика создаётся только в эпике оттуда',
  'cli.createdWithSources': 'Создан {ws}',
  'cli.epicTaskNext': '  Задача эпика {epic}, внесена в его tasks.md.',
  'cli.epicAttached': '  Из эпика: {list}.',
  'cli.epicAs.worktree': '{name} (worktree на {branch})',
  'cli.epicAs.link': '{name} (ссылка)',
  'cli.epicAs.reference': '{name} (справочный каталог)',
  'cli.epicNoGit': '  Git-репозитория из эпика нет: подключи его из задачи через wsg add <имя> (источники эпика: {list})\n  или wsg add <путь>; пока нет git-репозитория, wsg check пишет "setup not finished".',
  'cli.epicDefaultNeedsTicket': 'источник эпика {name} не взят: его шаблону ветки нужен ключ тикета задачи, а его нет. Задай --ticket <КЛЮЧ> или подключи позже через wsg add {name} --branch B',
  'cli.epicDefaultTicketNoKey': 'источник эпика {name} не взят: его шаблону ветки нужен ключ тикета задачи, а в заданном тикете {ticket} нет ключа, годного для имени ветки (вида PROJ-42). Задай в --ticket ключ или подключи позже через wsg add {name} --branch B',
  'cli.sourcesNeedEpic': '--sources есть только с --epic: задача вне эпика получает репозитории через wsg add',
  'cli.sourcesNone': '--sources none — только отдельно: либо none, либо список источников эпика',
  'cli.sourcesTwice': '--sources называет {name} дважды',
  'cli.epicUnreadable': 'эпик этой задачи не читается, поэтому не понять, есть ли у него источник {name}: {msg}\n  Чтобы подключить каталог с таким именем, укажи путь (./{name})',
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
  'cli.cancelledIncomplete': 'Отменено, но при откате были ошибки (выше): проверь воркспейс.',
  'cli.cancelledKept': 'Отменено. Воркспейс в прежнем состоянии, кроме оставленных выше файлов: {list}',
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
  'cli.checkFailed': 'wsg check нашёл ошибок: {fails}, предупреждений: {warns}',
  'list.empty': 'В {root} пока нет воркспейсов: wsg new <слаг> создаст первый.',
  'list.legacy': '(wsg 0.1: нет .claude/wsg.json)',
  'list.unreadable': '(состояние не читается: см. wsg check)',
  'list.notEpicTask': 'лежит в эпике {epic}, но его состояние не связывает его с эпиком',
  'list.badSource': 'источник №{n} — не источник: {value} — пропущен; поправь .claude/wsg.json руками',
  'list.orphanTask': 'его состояние называет эпик {epic}, но он лежит не в эпике: см. wsg check',
  'list.otherEpic': 'его состояние называет эпик {epic}: см. wsg check',
  'list.forEpicPending': '(«For the epic» в notes.md ещё не перенесён в эпик)',
  'cli.statusTask': 'укажи задачу: wsg status <задача> [open|review|done]',
  'cli.closeTask': 'укажи задачу: wsg close <задача>',
  'cli.badStatus': '{value} — не статус: допустимы {list}',
  'cli.statusEpic': '{ws} — эпик: статуса у него нет, он есть у его задач — укажи задачу как <эпик>/<задача>',
  'cli.statusSet': '{task}: {previous} -> {status}',
  'cli.statusSame': '{task} уже {status}: ничего не изменилось',
  'cli.statusTasksMd': 'Обновлён блок задач в {file}',
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
  'workspace.notEpic': '{ws} — не эпик',
  'workspace.badKind': 'вид воркспейса {kind}: только task, process или epic',
  'workspace.epicTaskKind': 'внутри эпика создаётся только задача, а не {kind}',
  'workspace.childReserved': 'задача эпика не может называться {slug}: это имя занято самим эпиком',
  'workspace.childIsSource': 'задача эпика не может называться {slug}: так называется источник эпика',

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
  'add.epicWorktree': 'у эпика нет своей ветки: его репозитории подключаются ссылками, а worktree получает каждая задача. Убери --worktree; ветки задач задаёт --branch-template',
  'add.branchInEpic': '{flag}: у эпика нет своей ветки — ветки его задач задаёт --branch-template',
  'add.taskDefaultsNeedTemplate': '{flag} описывает worktree задач эпика, поэтому нужен --branch-template; без него репозиторий подключается в каждую задачу ссылкой как есть',
  'add.templateOnlyEpic': '--branch-template есть только в эпике, а этот воркспейс — не эпик',
  'add.referenceIsGitEpic': '{path} под git: в эпике его подключают ссылкой — просто wsg add или --link; --reference — для каталогов вне git',
  'add.templateNotRepo': '--branch-template нужен git-репозиторий, а этот источник — {mode}',
  'add.templateSubdir': 'worktree задачи всегда целого репозитория: для --branch-template укажи его корень {top}',
  'add.templateEmpty': '--branch-template пустой',
  'add.templateText': '--branch-template {template}: одна строка, без обратной кавычки и без <!--: он показывается в AGENTS.md',
  'add.templateUnknown': '--branch-template {template}: {name} — не подстановка, есть только {slug} и {ticket}',
  'add.templateNoPlaceholder': '--branch-template {template} без {slug} и {ticket}: все задачи получили бы одну ветку',
  'add.templateInvalid': '--branch-template {template}: ветка задачи была бы {sample}, а это не имя ветки',
  'add.epicReserved': 'источник эпика не может называться {name}: его правило заменило бы .claude/rules/epic-knowledge.md эпика',
  'add.epicSourceUnknown': 'у эпика {epic} нет источника {name} (его источники: {list})',
  'add.templateNeedsTicket': 'шаблону ветки эпика {template} нужен ключ тикета задачи, а тикет не задан: создай задачу с --ticket <КЛЮЧ> или подключи источник позже из задачи через wsg add {name} --branch B',
  'add.templateTicketNoKey': 'шаблону ветки эпика {template} нужен ключ тикета задачи, а в заданном тикете {ticket} нет ключа, годного для имени ветки (вида PROJ-42): задай в --ticket ключ или подключи источник позже из задачи через wsg add {name} --branch B',
  'add.templateTaskNoKey': 'шаблону ветки эпика {template} нужен ключ тикета задачи, а в её состоянии ключа нет: задай --branch B',
  'add.epicNoneReserved': 'источник эпика не может называться none: wsg new --sources none значит «без источников»',
  'add.epicCarryGone': '{list} из списка carry эпика больше нет в основном чекауте: не копируется',
  'add.epicLinkedIntoTasks': '{name} подключается в каждую задачу эпика ссылкой как есть; чтобы задачи получали его worktree, подключи с --branch-template',

  'remove.unknown': 'источника {name} в этом воркспейсе нет (источники: {list})',
  'remove.dirty': 'в worktree {name} есть изменения, которых больше нигде нет — сначала закоммить, спрячь или удали их:\n{list}',
  'remove.ignored': 'в worktree {name} есть игнорируемые файлы, которых больше нигде нет (созданы там или скопированы wsg и с тех пор изменены), и git удалит их вместе с ним:\n{list}\n  Перенеси нужное, потом повтори команду с --delete-ignored',
  'remove.ignoredAppeared': 'в worktree {name} после проверки появились игнорируемые файлы, и git удалит их вместе с ним:\n{list}\n  Ничего не изменено; повтори команду',
  'remove.listFailed': 'worktree {name}: git не смог перечислить игнорируемые файлы ({why}), а git удалит их вместе с ним не глядя. Ничего не изменено',
  'remove.statusFailed': 'worktree {name}: git не смог перечислить изменения в нём ({why}), и они пропадут не глядя. Ничего не изменено',
  'remove.listTooLarge': 'worktree {name}: git перечисляет там файлов больше чем на 256 МиБ — слишком много для проверки, а git удалит их вместе с ним не глядя. Ничего не изменено.\n  Удали результаты сборки в нём вручную (сначала перенеси нужное), потом повтори команду',
  'remove.nmNotChecked': 'node_modules, который wsg склонировал в {name}, не проверяется: изменения внутри него удалятся вместе с worktree',
  'remove.epicTasksKeep': 'задачи эпика с источником {name} сохраняют его как есть: {list}. Его перестают получать только новые задачи',
  'remove.asWorktree': 'свой worktree',
  'remove.asLink': 'ссылка',
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
  'gen.addRollingBack': 'Подключение {name} прервано. Откатываю {ws}',
  'gen.undoFailed': 'Шаг отката не удался: {msg}',
  'gen.worktreeRemoveFailed': 'Не удалось снять worktree {name}: {out}',
  'gen.branchLeftAtBase': 'Ветка {name} осталась на базе, прежняя голова — в {backup}: {out}',
  'gen.branchRestored': 'Ветка {name} возвращена на прежнюю голову',
  'gen.branchRestoredNoUpstream': 'Ветка {name} возвращена на прежнюю голову, но её upstream всё ещё база — проверь git branch -vv',
  'gen.branchKept': 'Ветка {name} оставлена: в ней есть коммиты поверх {base}',
  'gen.branchDeleted': 'Удалена созданная ветка {name}',
  'gen.branchDeleteFailed': 'Ветка {name} осталась, удалить не удалось: {out}',
  'gen.rollbackDone': 'Откат выполнен.',
  'gen.rollbackIncomplete': { one: 'Откат завершился с ошибкой (выше): воркспейс может быть не в прежнем состоянии — проверь его', few: 'Откат завершился с {n} ошибками (выше): воркспейс может быть не в прежнем состоянии — проверь его', many: 'Откат завершился с {n} ошибками (выше): воркспейс может быть не в прежнем состоянии — проверь его', other: 'Откат завершился с {n} ошибками (выше): воркспейс может быть не в прежнем состоянии — проверь его' },
  'gen.restoreFailed': 'не удалось вернуть {file}: {msg}',
  'gen.rollbackDoneKept': 'Откат выполнен, кроме файлов, оставленных, потому что они изменились во время работы: {list}',
  'gen.creating': 'Создаю {ws}',
  'gen.epicRulesKept': 'AGENTS.md: Owner rules эпика не отрендерены: {why}. Блок <!-- wsg:epic-rules --> оставлен как был',
  'gen.epicRulesPlaceholder': 'AGENTS.md: Owner rules эпика не отрендерены: {why}. Блок <!-- wsg:epic-rules --> вместо них ссылается на ../AGENTS.md',
  'gen.epicContextKept': 'AGENTS.md: индекс контекста эпика не отрендерен: {why}. Блок <!-- wsg:epic-context --> оставлен как был',
  'gen.epicContextPlaceholder': 'AGENTS.md: индекс контекста эпика не отрендерен: {why}. Блок <!-- wsg:epic-context --> вместо него ссылается на ../context/',
  'fanout.done': 'done: не обновлялась',
  'fanout.otherEpic': 'в её состоянии указан эпик {epic}: не обновлялась (см. wsg check)',
  'fanout.interrupted': 'отменено до обновления этой задачи',
  'fanout.rollingBack': 'Обновление задачи {task} прервано. Откатываю её',
  'gen.epicRulesNoSection': 'AGENTS.md: в AGENTS.md эпика нет раздела ## Owner rules; блок <!-- wsg:epic-rules --> оставлен как был',
  'gen.epicRulesWhy.noAgentsMd': 'в {dir} нет AGENTS.md',
  'gen.epicRulesWhy.notWorkspace': '{dir} — не воркспейс wsg',
  'gen.epicRulesWhy.notEpic': '{dir} — воркспейс вида {kind}, а не эпик',
  'gen.epicRulesWhy.otherEpic': '{dir} — эпик {found}, а в состоянии задачи указан {slug}',
  'gen.epicRulesCopy': 'AGENTS.md: собственный раздел ## Owner rules задачи повторяет правила эпика, которые теперь рендерит блок <!-- wsg:epic-rules -->: удали раздел',
  'gen.epicRulesOverlap': 'AGENTS.md: {n} из {m} строк собственного раздела ## Owner rules задачи есть и у эпика, их теперь рендерит блок <!-- wsg:epic-rules -->: оставь там только правила самой задачи',
  'gen.ownerRulesWhy.marker': 'в них есть маркер <!-- wsg:… -->, он стал бы вторым генерируемым блоком',
  'gen.ownerRulesWhy.fence': 'в них не закрыт блок кода, он поглотил бы остаток AGENTS.md',
  'gen.branchAppeared': 'ветка {branch} появилась уже после проверки: запусти wsg add снова',
  'gen.branchGone': 'ветка {branch} пропала уже после проверки: запусти wsg add снова',
  'status.worktreeMissing': '{name}: worktree нет на месте, он не проверен',
  'status.dirty': 'в {name} незакоммиченных изменений: {n}:\n{list}',
  'status.dirtyUnknown': '{name}: не удалось прочитать изменения: {why}',
  'status.unpushed': '{name}: коммитов не на {ref}: {n}',
  'status.unpushedUnknown': '{name}: не понять, запушены ли коммиты: нет ни upstream, ни базы для сравнения',
  'status.forEpicPending': 'в «## For the epic» в notes.md остались записи: эпик их ещё не перенёс (wsg guide epic, раздел Closing)',
  'status.doneFromTask': 'done ставит сессия эпика или владелец, а не сессия самой задачи: ты внутри {ws}',
  'status.siblingUnreadable': 'в tasks.md нет строки для {task}: его состояние не читается (см. wsg check)',
  'cli.statusCancelled': 'Отменено, ничего не изменилось.',
  'gen.statusRollingBack': 'Смена статуса прервана. Откатываю {ws}',
  'gen.removeRollingBack': 'Удаление {name} прервано. Откатываю {ws}',
  'gen.worktreeReadded': 'Worktree {name} снова на {branch}; файлы, скопированные при создании (.env, node_modules), не вернулись',
  'gen.worktreeReaddFailed': 'Не удалось вернуть worktree {name} на {branch}: {out} — ветка осталась, подключи ее снова через wsg add',
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
  'gen.keptChanged': '{file} изменился, пока работал wsg, поэтому оставлен как есть: проверь его и запусти wsg refresh, если сгенерированные блоки в нём не те',
  'gen.keptChangedSettings': '{file} изменился, пока работал wsg, поэтому оставлен как есть: проверь permissions.additionalDirectories вручную, там может остаться каталог откаченного источника',
  'gen.keptChangedState': '{file} изменился, пока работал wsg, поэтому оставлен как есть: это состояние, из которого рендерятся сгенерированные файлы — проверь его вручную (wsg check покажет, если оно не читается)',
  'gen.keptChangedByHand': '{file} изменился, пока работал wsg, поэтому оставлен как есть: проверь его вручную и исправь или удали то, что записал этот запуск — wsg refresh его не трогает',
  'gen.markerRestored': '{file}: маркеров <!-- wsg:{name} --> не было — блок добавлен заново',
  'gen.blockAdded': '{file}: добавлен блок <!-- wsg:{name} --> (новый в wsg {version})',
  'gen.fileMissing': '{file} нет — его генерируемая часть не обновлена',
  'gen.settingsInvalid': '{file} — невалидный JSON ({msg}): сначала исправь его, wsg его не перезаписывает',

  'team.noPreset': 'укажи пресет: wsg team <пресет> (есть: {presets})',
  'team.epic': 'wsg team не запускается в эпике: его агентов загружают и все его задачи. Запусти в задаче эпика',
  'team.badPreset': 'нет пресета {preset}: есть — {presets}',
  'team.badRole': '--without: нет роли {role}; роли — {roles}',
  'team.noRoles': '--without не оставляет ни одной роли {preset}',
  'team.stateInvalid': '{file}: "team" — не { preset, roles } с именами ролей в kebab-case; сначала исправь вручную',
  'team.notADir': '{path} в {ws} — не каталог: wsg team пишет в него свои файлы',
  'team.skillMissing': '{file} нет — ссылка на team/workflow.md не добавлена',
  'team.rollingBack': 'Добавление команды прервано. Откатываю {ws}',

  'context.noVerb': 'wsg context ждёт одно из: add, note, remove, list (см. wsg help context)',
  'context.badVerb': 'неизвестная команда: context {verb} — wsg context принимает add, note, remove или list (см. wsg help context)',
  'context.need.add': 'укажи, что добавить: wsg context add <url|путь>',
  'context.need.note': 'укажи id заметки: wsg context note <id> --text T',
  'context.need.remove': 'укажи id элемента: wsg context remove <id> (их показывает wsg context list)',
  'context.epicOnly': '{ws} — воркспейс вида {kind}: в этой версии wsg context работает с эпиком — укажи его через --ws <эпик>',
  'context.noteSource': 'укажи текст заметки ровно одним из --text T, --from ФАЙЛ или --from -',
  'context.noteRead': 'не читается {from}: {msg}',
  'context.takenSource': 'context в {ws} — источник {name}: эпик хранит контекст в context/ — сначала отключи источник (wsg remove {name}) и подключи его под другим именем',
  'context.takenLink': '{path} — симлинк: эпик хранит контекст в context/, собственном каталоге — сначала убери ссылку',
  'context.takenFile': '{path} — файл: эпик хранит контекст в каталоге context/ — сначала убери файл',
  'context.takenTask': '{path} — задачный воркспейс: эпик хранит контекст в context/ — сначала перенеси задачу в другой каталог',
  'context.badText': '{flag} — одна строка, не длиннее {max} символов',
  'context.badId': 'id {id} не в kebab-case или длиннее {max} символов (a-z, 0-9, -)',
  'context.badUrl': 'добавить можно только ссылку http или https: {url}',
  'context.noFile': 'нет такого файла: {path}',
  'context.isDir': '{path} — каталог: каталог подключается как справочный источник — wsg add <путь> --reference --ws <эпик>',
  'context.notFile': '{path} — не обычный файл',
  'context.badName': 'файл с именем {name} нельзя положить в context/: {why} — сначала переименуй файл',
  'context.listedAlready': '{path} уже внесён, как {id}',
  'context.fileExists': '{path} уже есть и не внесён: внеси его через wsg context add {path} или сначала убери',
  'context.tooLarge': '{what} — {size}, потолок {max}: большой файл добавь ссылкой, а каталог таких — справочным источником (wsg add --reference)',
  'context.large': '{what} — {size}, больше {warn}: агент прочтёт его только частями',
  'context.blockTooLarge': 'блок индекса стал бы {bytes} Б, потолок {max}: его оплачивает каждая задача на каждом запросе — сократи заголовки и описания или убери элементы',
  'context.blockLarge': 'блок индекса — {bytes} Б, больше {warn}: его оплачивает каждая задача на каждом запросе — держи заголовки и описания короткими',
  'context.idTaken': 'id {id} уже занят ({type}): задай другой через --id',
  'context.idTakenDerived': 'id {id}, полученный из имени, уже занят ({type}): задай другой через --id',
  'context.noteEmpty': 'заметка пустая',
  'context.noteBinary': 'заметка — не текст в UTF-8: бинарный файл добавь через wsg context add <путь>',
  'context.noteExists': 'заметка {id} уже есть: --replace перепишет её',
  'context.noNote': 'нет заметки {id}, переписывать нечего: без --replace будет записана новая',
  'context.replaceNotNote': '{id} — {type}, а не заметка: --replace переписывает только заметки',
  'context.unknown': 'в контексте нет элемента {id} (есть: {list})',
  'context.urlSecret': 'в ссылке {url} может быть секрет (данные пользователя или token, key, password, auth, sig в запросе): она попадёт в AGENTS.md каждой задачи — по возможности добавь её без секрета',
  'context.inNotes': '{path} лежит в context/notes/: внесённый как файл, он стал бы второй копией заметки — вынеси его из context/ и запиши через wsg context note <id> --from <файл>',
  'context.inPlaceLink': '{path} — симлинк в context/: внесённый как есть, индекс указывал бы за пределы эпика — положи туда сам файл или добавь цель ссылки с её места (она скопируется)',
  'context.edited': '{path} изменён после того, как его записал wsg: --discard-edits потеряет эти правки, или сначала скопируй их',
  'context.unreadable': '{path} не читается, и не понять, правили ли его после записи wsg: сначала поправь права',
  'context.overMax': 'больше {max}',
  'context.fileKept': '{path} лежал в context/ до того, как его внесли: он только убран из индекса, файл остаётся',
  'context.fanoutInterrupted': 'Остановлено. Изменение контекста {epic} сохранено; не обновлены задачи: {list} — запусти wsg refresh в каждой (wsg check в эпике их назовёт)',
  'context.fileGone': '{path} уже нет: убрана только его строка в индексе',
  'context.rollingBack': 'Изменение контекста прервано. Откатываю {ws}',
  'context.added': 'В контекст {epic} добавлен {type} {id}',
  'context.noted': 'В контекст {epic} записана заметка {id}',
  'context.replaced': 'В контексте {epic} переписана заметка {id}',
  'context.removed': 'Из контекста {epic} убран {type} {id}',
  'context.tasksRefreshed': 'Обновлены задачи: {list}',
  'context.tasksDone': 'Выполненные задачи оставлены как есть: {list}',
  'context.taskNotRefreshed': 'задача {task} не обновлена: {reason} — запусти в ней wsg refresh позже',
  'context.restart': 'Уже запущенные сессии видят индекс, с которым стартовали; сами файлы читаются сразу.',
  'context.listEmpty': 'В {epic} пока нет контекста: wsg context add <url|путь>, wsg context note <id> --text T',
  'context.listBlock': '  блок индекса в каждой задаче: {bytes} Б (предупреждение больше {warn}, отказ больше {max})',

  'mcp.jsonInvalid': '{file} не читается ({msg}): wsg рендерит в него MCP-серверы эпика — сначала исправь его, wsg его не перезаписывает',
  'mcp.ownerEntry': 'в {file} есть сервер {name}, который положил туда не wsg: сервер эпика заменил бы его — дай серверу эпика другое имя или сначала переименуй или убери тот',
  'mcp.settingsInvalid': '{file}: "{key}" — не список: wsg рендерит в него MCP-серверы эпика — сначала исправь его, wsg его не перезаписывает',

  'mcp.noVerb': 'wsg mcp ждёт одно из: add, remove, disable, enable, list (см. wsg help mcp)',
  'mcp.badVerb': 'неизвестная команда: mcp {verb} — wsg mcp принимает add, remove, disable, enable или list (см. wsg help mcp)',
  'mcp.need.add': 'укажи сервер: wsg mcp add <имя> -- <команда> [аргументы...] или wsg mcp add <имя> --url URL',
  'mcp.need.remove': 'укажи имя сервера: wsg mcp remove <имя> (их показывает wsg mcp list)',
  'mcp.need.disable': 'укажи глобальный сервер, который выключить: wsg mcp disable <имя> (серверы пользователя показывает wsg mcp list)',
  'mcp.need.enable': 'укажи сервер, который включить обратно: wsg mcp enable <имя>',
  'mcp.codexNotYet': 'MCP для Codex пока не поддерживается: в этой версии wsg mcp рендерит серверы только для Claude Code (--agent claude)',
  'mcp.badAgent': 'неизвестный агент {agent}: --agent принимает claude',
  'mcp.epicOnly': '{ws} — воркспейс вида {kind}: в этой версии wsg mcp работает с эпиком — укажи его через --ws <эпик>',
  'mcp.badName': 'имя сервера {name} — буквы, цифры, - и _, не длиннее {max} символов',
  'mcp.exists': 'у эпика уже есть сервер {name}: сначала wsg mcp remove {name} или возьми другое имя',
  'mcp.nameDisabled': '{name} — глобальный сервер, который эпик выключает: сначала wsg mcp enable {name} или возьми другое имя',
  'mcp.urlAndCommand': 'укажи либо команду после --, либо --url, не то и другое',
  'mcp.needCommand': 'как запускается {name}? wsg mcp add {name} -- <команда> [аргументы...] или wsg mcp add {name} --url URL',
  'mcp.envForStdio': '--env — для сервера, который запускается командой; http-сервер берёт токен через --bearer-env VAR',
  'mcp.bearerForHttp': '--bearer-env — для http-сервера (--url); команда берёт переменные через --env',
  'mcp.badUrl': 'MCP-сервером может быть только адрес http или https: {url}',
  'mcp.badCommand': 'команда — одна строка текста',
  'mcp.badArg': 'аргумент {n} — одна строка текста',
  'mcp.badEnvName': '{name} — не имя переменной (буквы, цифры и _, не с цифры)',
  'mcp.badEnvValue': 'значение {name} — одна строка текста',
  'mcp.envTwice': 'переменная {name} указана дважды',
  'mcp.secretLiteral': '{name} похожа на секрет: её значение попало бы в .mcp.json, который читает агент каждой задачи — экспортируй {name} в шелле и укажи --env {name} без значения: {server} возьмёт её из окружения',
  'mcp.argSecret': 'в аргументе {n} сервера {server} ({what}) может быть секрет: он попадёт в .mcp.json, который читает агент каждой задачи — положи его в переменную и напиши в аргументе ${VAR}',
  'mcp.urlSecret': 'в адресе {server} может быть секрет: он попадёт в .mcp.json, который читает агент каждой задачи — токен передавай через --bearer-env VAR',
  'mcp.shadowsGlobal': 'в пользовательском конфиге Claude Code тоже есть сервер {name}: в эпике и его задачах это имя займёт сервер эпика',
  'mcp.unknown': 'у эпика нет сервера {name} (есть: {list})',
  'mcp.badDeniedName': 'имя {name} — одна строка, не длиннее {max} символов',
  'mcp.disableOwn': '{name} — собственный сервер эпика: его убирает wsg mcp remove {name}',
  'mcp.alreadyDisabled': '{name} уже выключен: менять нечего',
  'mcp.notGlobal': 'в пользовательском конфиге Claude Code нет сервера {name}: выключен всё равно — сервер плагина называется plugin:<плагин>:<сервер>',
  'mcp.notDisabled': '{name} в эпике не выключен: менять нечего',
  'mcp.rollingBack': 'Изменение MCP-серверов прервано. Откатываю {ws}',
  'mcp.fanoutInterrupted': 'Остановлено. Изменение MCP-серверов {epic} сохранено; не обновлены задачи: {list} — запусти wsg refresh в каждой (wsg check в эпике их назовёт)',
  'mcp.done.add': 'В {epic} добавлен MCP-сервер {name}',
  'mcp.done.remove': 'Из {epic} убран MCP-сервер {name}',
  'mcp.done.disable': '{name} выключен в {epic} и его задачах',
  'mcp.done.enable': '{name} снова включён в {epic} и его задачах',
  'mcp.unchanged': 'MCP-серверы {epic} остались как были',
  'mcp.restart': 'Перезапусти сессии агента в эпике и его задачах: Claude Code читает MCP-серверы при старте. В терминале серверы эпика в задаче остаются "Pending approval", пока её папке не доверятся — один раз на каталог задачи.',
  'mcp.listEmpty': 'В {epic} пока нет MCP-серверов: wsg mcp add <имя> -- <команда> [аргументы...] или --url URL',
  'mcp.listDisabled': 'выключены (claude): {list}',
  'mcp.listGlobal': 'серверы пользователя (claude): {list}',
  'mcp.listPlugins': '  серверы плагинов и коннекторы claude.ai не показаны: сервер плагина выключается по имени plugin:<плагин>:<сервер>',
  'mcp.listMissing': 'не заданы в этом шелле: {list} — серверы, которые их читают, стартуют без них',

  'lock.busy': 'в этом воркспейсе уже идёт другая команда wsg (pid {pid}, с {time}): дождись её.\n  Если она не идёт, удали {file}',
  'lock.stale': 'устаревшая блокировка {file} (процесса {pid} нет): забираю её',

  'promote.noWorkspace': 'нет воркспейса {ws}',
  'promote.notWorkspace': '{ws} не похож на воркспейс wsg: нет .claude/ws-kind',
  'promote.epic': 'эпик не превращается в процесс',
  'promote.epicTask': 'задача эпика пока не превращается в процесс',
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
  'ws.list.epic': 'эпик',
  'ws.list.sessions': 'сессий',
  'ws.list.runs': 'прогонов',
  'ws.list.shared': '(общий чекаут)',
  'ws.list.create': 'создать: wsg new <slug> · сменить агента: ws --agent',
  'ws.jump.ambiguous': 'неоднозначно: {list}',
  'ws.jump.none': "нет воркспейса '{slug}'. Список: ws",
  'ws.agent.nothingToRun': 'в WSG_AGENT из {WSG_CONFIG} нечего запускать',
};
