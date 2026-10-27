# verTEX

A small 3D editor for low-poly models with pixel-art textures, in the spirit of
PSX-era and Minecraft-like games, which exports to Godot.

[Русская версия ниже](#русский)

## About this project

I made verTEX for myself, for my own games and projects. It is not meant to
compete with Blender or anything else, and it doesn't try to be popular. It is
just my idea of what a low-poly 3D editor should feel like: few tools, a pixel
grid everywhere, and a straight path from a model to the game.

It is shared as it is. Things may change or break between versions, and
features are added when I need them in my own work.

The program was written with the help of [Claude](https://www.anthropic.com/claude)
(Anthropic): a lot of the code was made together with Claude Code, with me
deciding what the editor should do and how it should feel.

## What it does

- **Modelling.** Vertices, edges, faces and objects. Primitives (cube, cone,
  cylinder, sphere, capsule), extrude, cut, polygons, mirror modelling, grid
  snapping and snapping to other elements, groups.
- **Textures.** Texture atlases with a fixed pixel density, so every face gets
  pixels of the same size. A UV editor, painting right on the model or in an
  external editor such as Aseprite.
- **Godot.** glTF export with collision shapes, keyframe animations and
  skinned meshes that Godot imports as they are.
- **The rest.** A physics preview, rendering sprites from the model, English
  and Russian interface, colour themes.

## Download

The installer is in [Releases](https://github.com/mku91/verTEX/releases). Once
installed, the program offers new versions itself as it starts.

## Running and building

You need [Node.js](https://nodejs.org/) and [Rust](https://rustup.rs/): the app
is built with [Tauri](https://tauri.app/) and [three.js](https://threejs.org/).
Windows is the only platform it is made and tested on.

```sh
npm install
npm start       # the app in development mode
npm run build   # dist/: verTEX.exe (one file, about 6 MB) and its installer
```

## License

verTEX is source-available, not open source in the strict sense: the code is
open, but the program may not be sold. In short:

- **Use it for anything**, commercial work included. What you make with it -
  models, textures, exported files - is yours: use and sell it as you like.
- **Fork it and change it** as you like, and share your version, for free.
- **Don't sell it**: neither verTEX nor a fork of it may be sold or distributed
  for money. A fork stays under the same terms.

The full terms are in [LICENSE](LICENSE): the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
with an additional permission for any use of the program and of what is made
with it.

---

## Русский

Небольшой 3D-редактор для low-poly моделей с пиксельными текстурами, в духе
игр эпохи PSX и Minecraft, с экспортом в Godot.

### О проекте

verTEX я делал исключительно для себя, для своих игр и проектов. Он не пытается
соперничать с Blender или чем-то ещё и не претендует на популярность. Это
просто моё видение того, каким должен быть 3D-редактор для low-poly: мало
инструментов, пиксельная сетка во всём и прямой путь от модели до игры.

Проект выложен как есть. От версии к версии что-то может меняться или
ломаться, а новые возможности появляются тогда, когда они нужны мне самому.

Программа написана с помощью [Claude](https://www.anthropic.com/claude)
(Anthropic): большая часть кода сделана вместе с Claude Code, а я решал, что
редактор должен уметь и каким должен быть в работе.

### Что умеет

- **Моделирование.** Вершины, рёбра, грани и объекты. Примитивы (куб, конус,
  цилиндр, сфера, капсула), выдавливание, разрез, полигоны, зеркальное
  моделирование, привязка к сетке и к другим элементам, группы.
- **Текстуры.** Атласы с постоянной плотностью пикселей: на всех гранях пиксель
  одного размера. Редактор UV, рисование прямо на модели или во внешнем
  редакторе вроде Aseprite.
- **Godot.** Экспорт в glTF с коллизиями, анимацией по ключевым кадрам и
  скиннингом, которые Godot импортирует как есть.
- **Прочее.** Предпросмотр физики, рендер спрайтов из модели, английский и
  русский интерфейс, цветовые темы.

### Скачать

Установщик лежит в [Releases](https://github.com/mku91/verTEX/releases). После
установки программа сама предлагает новые версии при запуске.

### Запуск и сборка

Нужны [Node.js](https://nodejs.org/) и [Rust](https://rustup.rs/): программа
собрана на [Tauri](https://tauri.app/) и [three.js](https://threejs.org/).
Делается и проверяется только под Windows.

```sh
npm install
npm start       # программа в режиме разработки
npm run build   # dist/: verTEX.exe (один файл, около 6 МБ) и установщик
```

### Лицензия

verTEX — source-available, а не open source в строгом смысле: код открыт, но
программу нельзя продавать. Коротко:

- **Пользоваться можно для чего угодно**, в том числе в коммерческой работе.
  Всё, что в ней сделано (модели, текстуры, экспортированные файлы), твоё:
  используй и продавай как хочешь.
- **Форкать и менять можно** как угодно и делиться своей версией, бесплатно.
- **Продавать нельзя**: ни verTEX, ни его форк нельзя продавать или
  распространять за деньги. Форк остаётся под теми же условиями.

Полные условия в [LICENSE](LICENSE):
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
с дополнительным разрешением на любое использование программы и того, что в
ней сделано.
