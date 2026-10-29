# Setup

This section will cover how to setup your environment for this extension, and how to manually debug and test it.

## Startup

### Fork and Clone

First of all, fork this repository into your github account and clone it on your local machine.

### Install NodeJS

NodeJS is required for this project, but don't worry, to keep things clear and avoid colliding NodeJS versions with your other projects, we do support [Mise](https://mise.jdx.dev/).

The easiest way to use NodeJS for this project is to use `mise`. [See their documentation for the installation process](https://mise.jdx.dev/installing-mise.html).

Although, this is also possible to use NodeJS without this if you wish. Install it manually, [see their documentation to get more installation details](https://nodejs.org/en/download). Remember that we use the version `@25.2.1`, but you probably can use newer versions.

### Install Bun

Install Bun 1.3.12 (`mise install` uses the pinned version). Bun manages dependencies and development scripts; Node runs the language server.

### Install dependencies

To install dependencies, just run:

```sh
$ bun install --frozen-lockfile
```

## Running in developer mode

To be able to run this extension locally, you need to compile it first:

```sh
$ bun run compile
```

Then you need to open a new debug window with our extension loaded. 

So press <kbd>F5</kbd>.

> [!WARNING]
> If you're using a compact keyboard (i.e. laptop), make sure you have <kbd>Fn</kbd> activated. Some devices allow you to toggle <kbd>Fn</kbd> via <kbd>Fn Lock</kbd>, otherwise, use the key combination <kbd>Fn</kbd> + <kbd>F5</kbd>.

## Reloading extension

Remember, after some code change you need to compile it again and then reload your debugging window.

### Closed Debugging Window

If you have your debugging window running, you can follow the same steps as mentioned before.

Compile it again with `bun run compile`, then open the debugging window via <kbd>F5</kbd>.

### Debugging Window already open

If you have a debugging window open, you still need to recompile your project, but you don't need to close your debugging window to be able to reload your extension.

On your development window, compile it with `bun run compile`, then open your debugging window and reload with <kbd>Ctrl</kbd> + <kbd>R</kbd> (<kbd>Cmd</kbd> + <kbd>R</kbd> on Macbook).
