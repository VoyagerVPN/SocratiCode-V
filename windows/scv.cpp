#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shldisp.h>
#include <exdisp.h>
#include <servprov.h>
#include <winhttp.h>
#include <fcntl.h>
#include <io.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <utility>
#include <vector>
#include "tray-resources.h"

namespace fs = std::filesystem;
using namespace winrt;
using namespace Windows::Data::Json;
using namespace std::literals;
constexpr auto protocol = L"2026-07-28";

struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, nullptr)) {}
    explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
struct HttpHandle {
    HINTERNET value;
    explicit HttpHandle(HINTERNET h) : value(h) {}
    ~HttpHandle() { if (value) WinHttpCloseHandle(value); }
    operator HINTERNET() const { return value; }
};

[[noreturn]] void fail(const char* action) {
    throw std::runtime_error(std::string(action) + " (Windows " + std::to_string(GetLastError()) + ")");
}

fs::path executable() {
    std::wstring filename(32768, L'\0');
    const auto length = GetModuleFileNameW(nullptr, filename.data(), static_cast<DWORD>(filename.size()));
    if (!length || length >= filename.size()) fail("SocratiCode V executable path");
    filename.resize(length);
    return filename;
}

JsonObject readObject(const fs::path& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot read " + to_string(path.wstring()));
    return JsonObject::Parse(to_hstring(std::string(std::istreambuf_iterator<char>(input), {})));
}

struct Profile {
    fs::path path;
    JsonObject json;
    std::wstring name;
    explicit Profile(const fs::path& file) : path(fs::canonical(file)), json(readObject(path)) {
        auto key = path.wstring();
        CharLowerBuffW(key.data(), static_cast<DWORD>(key.size()));
        uint64_t hash = 14695981039346656037ULL;
        for (const auto ch : key) hash = (hash ^ ch) * 1099511628211ULL;
        name = L"Local\\SocratiCodeV-" + std::to_wstring(hash) + L"-";
    }
    std::wstring get(const wchar_t* key) const { return std::wstring(json.GetNamedString(key)); }
    INTERNET_PORT port(const wchar_t* key) const {
        const auto value = json.GetNamedNumber(key);
        if (value < 1 || value > 65535 || value != static_cast<INTERNET_PORT>(value)) throw std::runtime_error("Invalid SCV port");
        return static_cast<INTERNET_PORT>(value);
    }
};

std::wstring quote(std::wstring_view value) {
    std::wstring out(1, L'"');
    size_t slashes = 0;
    for (const auto ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        out.append(ch == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        out += ch;
        slashes = 0;
    }
    out.append(slashes * 2, L'\\');
    out += L'"';
    return out;
}

struct BString {
    BSTR value;
    explicit BString(const wchar_t* text) : value(SysAllocString(text)) { if (!value) throw std::bad_alloc(); }
    ~BString() { SysFreeString(value); }
    VARIANT variant() const {
        VARIANT result{};
        result.vt = VT_BSTR;
        result.bstrVal = value;
        return result;
    }
};

void openFromDesktop(const fs::path& binary, const std::vector<std::wstring>& args, const fs::path& cwd) {
    // Explorer остаётся владельцем приложения, когда клиент закрывает свой MCP-процесс.
    auto shellWindows = create_instance<IShellWindows>(CLSID_ShellWindows, CLSCTX_LOCAL_SERVER);
    VARIANT desktop{}, unused{};
    desktop.vt = VT_I4;
    desktop.lVal = CSIDL_DESKTOP;
    long desktopWindow = 0;
    com_ptr<IDispatch> dispatch;
    check_hresult(shellWindows->FindWindowSW(&desktop, &unused, SWC_DESKTOP, &desktopWindow, SWFO_NEEDDISPATCH, dispatch.put()));
    if (!dispatch) throw std::runtime_error("Windows desktop is unavailable. Open SocratiCode V from Explorer.");
    auto services = dispatch.as<IServiceProvider>();
    com_ptr<IShellBrowser> browser;
    check_hresult(services->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(browser.put())));
    com_ptr<IShellView> view;
    check_hresult(browser->QueryActiveShellView(view.put()));
    com_ptr<IDispatch> background;
    check_hresult(view->GetItemObject(SVGIO_BACKGROUND, IID_PPV_ARGS(background.put())));
    com_ptr<IDispatch> application;
    check_hresult(background.as<IShellFolderViewDual>()->get_Application(application.put()));
    auto shell = application.as<IShellDispatch2>();
    std::wstring arguments;
    for (const auto& arg : args) { if (!arguments.empty()) arguments += L' '; arguments += quote(arg); }
    BString file(binary.c_str()), parameters(arguments.c_str()), directory(cwd.c_str()), verb(L"open");
    VARIANT show{};
    show.vt = VT_I4;
    show.lVal = SW_HIDE;
    check_hresult(shell->ShellExecute(file.value, parameters.variant(), directory.variant(), verb.variant(), show));
}

Handle spawnChild(const fs::path& binary, const std::vector<std::wstring>& args, const fs::path& cwd,
                  HANDLE job = nullptr, HANDLE input = nullptr, HANDLE log = nullptr, bool independent = false) {
    std::wstring command = quote(binary.wstring());
    for (const auto& arg : args) command += L" " + quote(arg);
    STARTUPINFOW si{sizeof(si)};
    if (log) {
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = input;
        si.hStdOutput = si.hStdError = log;
    }
    PROCESS_INFORMATION pi{};
    const DWORD flags = independent ? DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB : CREATE_NO_WINDOW;
    if (!CreateProcessW(binary.c_str(), command.data(), nullptr, nullptr, log != nullptr,
                        flags | (job ? CREATE_SUSPENDED : 0), nullptr, cwd.c_str(), &si, &pi)) {
        if (!independent || GetLastError() != ERROR_ACCESS_DENIED) fail("Cannot launch SCV process");
        openFromDesktop(binary, args, cwd);
        return Handle{};
    }
    Handle process(pi.hProcess), thread(pi.hThread);
    if (job && (!AssignProcessToJobObject(job, process.value) || ResumeThread(thread.value) == DWORD(-1))) {
        const auto error = GetLastError();
        TerminateProcess(process.value, 1);
        SetLastError(error);
        fail("Cannot attach process to SCV job");
    }
    return process;
}

std::string http(INTERNET_PORT port, std::wstring_view route, const wchar_t* verb, std::wstring_view headers = {},
                 std::string body = {}, int timeout = 1000) {
    HttpHandle session(WinHttpOpen(L"SocratiCode V", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0));
    if (!session) fail("WinHttpOpen");
    WinHttpSetTimeouts(session, 1000, 1000, 1000, timeout);
    HttpHandle conn(WinHttpConnect(session, L"127.0.0.1", port, 0));
    HttpHandle req(WinHttpOpenRequest(conn, verb, std::wstring(route).c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    if (!req) fail("WinHttpOpenRequest");
    DWORD disabled = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    WinHttpSetOption(req, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled));
    if (!WinHttpSendRequest(req, headers.data(), static_cast<DWORD>(headers.size()), body.data(), static_cast<DWORD>(body.size()),
                           static_cast<DWORD>(body.size()), 0) || !WinHttpReceiveResponse(req, nullptr)) fail("SCV HTTP connection");
    std::string result;
    char buffer[8192];
    DWORD count;
    do {
        if (!WinHttpReadData(req, buffer, sizeof(buffer), &count)) fail("SCV HTTP response");
        result.append(buffer, count);
        if (result.size() > 8 * 1024 * 1024) throw std::runtime_error("SCV response too large");
    } while (count);
    return result;
}

bool listening(INTERNET_PORT port, const wchar_t* route) {
    try { http(port, route, L"GET"); return true; }
    catch (...) { return false; }
}

bool waitUntilListening(HANDLE process, INTERNET_PORT port, const wchar_t* route) {
    for (int attempt = 0; attempt < 150; ++attempt) {
        if (process && WaitForSingleObject(process, 0) != WAIT_TIMEOUT) return false;
        if (listening(port, route)) return true;
        Sleep(100);
    }
    return false;
}

void env(const wchar_t* key, const std::wstring& value) {
    if (!SetEnvironmentVariableW(key, value.c_str())) fail("SCV subprocess environment");
}

std::wstring localUrl(INTERNET_PORT port) { return L"http://127.0.0.1:" + std::to_wstring(port); }

constexpr UINT trayMessage = WM_APP + 1;
constexpr UINT stopMenuItem = 1;
constexpr UINT logsMenuItem = 2;
constexpr UINT colorMenuItem = 3;
constexpr UINT monoMenuItem = 4;

bool systemThemeIsDark() {
    DWORD light = 1;
    DWORD size = sizeof(light);
    return RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                        L"SystemUsesLightTheme", RRF_RT_REG_DWORD, nullptr, &light, &size) == ERROR_SUCCESS && light == 0;
}

struct Tray {
    HANDLE stop = nullptr;
    fs::path logs;
    fs::path stylePath;
    NOTIFYICONDATAW icon{};
    UINT taskbar = RegisterWindowMessageW(L"TaskbarCreated");
    UINT style = colorMenuItem;
    UINT iconResource = 0;
    UINT iconDpi = 0;

    bool updateIcon() {
        if (!icon.hWnd) return false;
        const bool dark = systemThemeIsDark();
        const UINT resource = style == monoMenuItem ? (dark ? IDI_SCV_MONO_DARK : IDI_SCV_MONO_LIGHT)
                                                    : (dark ? IDI_SCV_COLOR_DARK : IDI_SCV_COLOR_LIGHT);
        const UINT dpi = GetDpiForWindow(icon.hWnd);
        if (resource == iconResource && dpi == iconDpi) return false;
        const auto next = static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(resource), IMAGE_ICON,
            GetSystemMetricsForDpi(SM_CXSMICON, dpi), GetSystemMetricsForDpi(SM_CYSMICON, dpi), 0));
        if (!next) return false;
        SendMessageW(icon.hWnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(next));
        const auto previous = std::exchange(icon.hIcon, next);
        if (previous) DestroyIcon(previous);
        iconResource = resource;
        iconDpi = dpi;
        return true;
    }

    bool add() {
        updateIcon();
        if (!icon.hIcon) return false;
        if (!Shell_NotifyIconW(NIM_ADD, &icon)) return false;
        icon.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &icon);
        return true;
    }

    void refresh() {
        if (!updateIcon()) return;
        auto changed = icon;
        changed.uFlags = NIF_ICON;
        if (!Shell_NotifyIconW(NIM_MODIFY, &changed)) add();
    }

    bool command(UINT item) {
        if (item == stopMenuItem) { SetEvent(stop); return true; }
        if (item == logsMenuItem) { ShellExecuteW(icon.hWnd, L"open", logs.c_str(), nullptr, nullptr, SW_SHOWNORMAL); return true; }
        if (item != colorMenuItem && item != monoMenuItem) return false;
        if (style != item) {
            style = item;
            const auto temporary = stylePath.wstring() + L".tmp";
            std::ofstream output(fs::path(temporary), std::ios::binary | std::ios::trunc);
            output << (style == monoMenuItem ? "monochrome\n" : "color\n");
            output.close();
            if (output) MoveFileExW(temporary.c_str(), stylePath.c_str(), MOVEFILE_REPLACE_EXISTING);
            refresh();
        }
        return true;
    }

    static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
        if (message == WM_NCCREATE) {
            SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams));
        }
        const auto self = reinterpret_cast<Tray*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (!self) return DefWindowProcW(window, message, wparam, lparam);
        if (message == self->taskbar) { self->add(); return 0; }
        if (message == WM_SETTINGCHANGE || message == WM_THEMECHANGED || message == WM_DPICHANGED) self->refresh();
        if (message == WM_ENDSESSION && wparam) SetEvent(self->stop);
        if (message == WM_COMMAND && self->command(LOWORD(wparam))) return 0;
        if (message == trayMessage && (LOWORD(lparam) == WM_CONTEXTMENU || LOWORD(lparam) == NIN_KEYSELECT)) {
            auto menu = CreatePopupMenu();
            AppendMenuW(menu, MF_STRING, colorMenuItem, L"Цветной");
            AppendMenuW(menu, MF_STRING, monoMenuItem, L"Монохромный");
            CheckMenuRadioItem(menu, colorMenuItem, monoMenuItem, self->style, MF_BYCOMMAND);
            AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
            AppendMenuW(menu, MF_STRING, logsMenuItem, L"Журналы");
            AppendMenuW(menu, MF_STRING, stopMenuItem, L"Выйти из SocratiCode V");
            POINT position{};
            GetCursorPos(&position);
            SetForegroundWindow(window);
            const auto item = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY, position.x, position.y, 0, window, nullptr);
            DestroyMenu(menu);
            PostMessageW(window, WM_NULL, 0, 0);
            if (item) SendMessageW(window, WM_COMMAND, item, 0);
            return 0;
        }
        return DefWindowProcW(window, message, wparam, lparam);
    }
    bool open(HANDLE event, const fs::path& folder, const fs::path& data) {
        stop = event;
        logs = folder;
        stylePath = data / L"tray-style.txt";
        std::string saved;
        std::ifstream(stylePath) >> saved;
        if (saved == "monochrome") style = monoMenuItem;
        const auto module = GetModuleHandleW(nullptr);
        const WNDCLASSW cls{0, proc, 0, 0, module, nullptr, nullptr, nullptr, nullptr, L"SocratiCodeV.Tray"};
        if (!RegisterClassW(&cls)) return false;
        icon.cbSize = sizeof(icon);
        icon.hWnd = CreateWindowExW(WS_EX_TOOLWINDOW, cls.lpszClassName, L"SocratiCode V", WS_OVERLAPPED,
                                   0, 0, 0, 0, nullptr, nullptr, module, this);
        if (!icon.hWnd) return false;
        icon.uID = 1;
        icon.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        icon.uCallbackMessage = trayMessage;
        wcscpy_s(icon.szTip, L"SocratiCode V");
        return add();
    }
    ~Tray() {
        if (icon.hWnd) { Shell_NotifyIconW(NIM_DELETE, &icon); DestroyWindow(icon.hWnd); }
        if (icon.hIcon) DestroyIcon(icon.hIcon);
    }
};

Handle createEvent(const Profile& p, const wchar_t* suffix, bool manual) {
    Handle handle(CreateEventW(nullptr, manual, FALSE, (p.name + suffix).c_str()));
    if (!handle) fail("SCV event creation");
    return handle;
}

int serve(const Profile& p) {
    Handle owner(CreateMutexW(nullptr, TRUE, (p.name + L"owner").c_str()));
    const auto lockError = GetLastError();
    if (!owner) fail("SCV singleton");
    if (lockError == ERROR_ALREADY_EXISTS) return 0;
    const fs::path data = p.get(L"data");
    const fs::path logs = data / L"logs";
    fs::create_directories(logs);
    fs::create_directories(data / L"runtime");
    SECURITY_ATTRIBUTES io{sizeof(io), nullptr, TRUE};
    Handle log(CreateFileW((logs / L"scv.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &io, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    Handle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &io, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!log || !nullInput) fail("SCV log or stdin");
    auto ready = createEvent(p, L"ready", true);
    auto stop = createEvent(p, L"stop", true);
    auto embeddings = createEvent(p, L"ollama", false);
    auto ollamaOwned = createEvent(p, L"ollama-owned", true);
    const auto mcpPort = p.port(L"mcpPort");
    const auto qdrantPort = p.port(L"qdrantPort");
    const auto ollamaPort = p.port(L"ollamaPort");
    if (listening(mcpPort, L"/mcp") || listening(qdrantPort, L"/readyz") || listening(ollamaPort, L"/api/version"))
        throw std::runtime_error("SCV lab port already occupied");

    Handle job(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) fail("SCV job setup");

    env(L"QDRANT__SERVICE__HOST", L"127.0.0.1");
    env(L"QDRANT__SERVICE__HTTP_PORT", std::to_wstring(qdrantPort));
    env(L"QDRANT__SERVICE__GRPC_PORT", std::to_wstring(p.port(L"qdrantGrpcPort")));
    env(L"QDRANT__STORAGE__STORAGE_PATH", (data / L"qdrant").wstring());
    env(L"QDRANT__STORAGE__SNAPSHOTS_PATH", (data / L"snapshots").wstring());
    env(L"QDRANT__CLUSTER__ENABLED", L"false");
    auto qdrant = spawnChild(p.get(L"qdrant"), {L"--disable-telemetry"}, data, job.value, nullInput.value, log.value);
    if (!waitUntilListening(qdrant.value, qdrantPort, L"/readyz")) throw std::runtime_error("SCV Qdrant did not start");

    env(L"SOCRATICODE_MCP_TRANSPORT", L"http");
    env(L"SOCRATICODE_MCP_PORT", std::to_wstring(mcpPort));
    env(L"SOCRATICODE_RUNTIME_DIR", (data / L"runtime").wstring());
    env(L"SOCRATICODE_AUTO_RESUME", L"off");
    env(L"SOCRATICODE_WATCHER", L"auto");
    env(L"SOCRATICODE_LOCAL_CLEANUP", L"off");
    env(L"QDRANT_MODE", L"external");
    env(L"QDRANT_URL", localUrl(qdrantPort));
    env(L"OLLAMA_MODE", L"external");
    env(L"OLLAMA_URL", localUrl(ollamaPort));
    env(L"OLLAMA_MAX_CONNECTIONS", L"1");
    env(L"EMBEDDING_PROVIDER", L"ollama");
    env(L"EMBEDDING_MODEL", L"hf.co/jinaai/jina-embeddings-v5-text-nano-retrieval:F16");
    env(L"EMBEDDING_DIMENSIONS", L"768");
    env(L"EMBEDDING_CONTEXT_LENGTH", L"2048");
    env(L"EMBEDDING_QUERY_PREFIX", L"Query: ");
    env(L"EMBEDDING_DOCUMENT_PREFIX", L"Document: ");
    env(L"PILOT_SQLITE_DB", (data / L"scv.sqlite").wstring());
    env(L"SCV_PROFILE", p.path.wstring());
    env(L"SCV_LAUNCHER", executable().wstring());
    HANDLE input = nullptr, output = nullptr;
    if (!CreatePipe(&input, &output, &io, 0)) fail("SCV shutdown pipe");
    HANDLE backendOutput = output;
    Handle inputReader(input);
    if (!SetHandleInformation(backendOutput, HANDLE_FLAG_INHERIT, 0)) { CloseHandle(backendOutput); fail("SCV shutdown pipe inheritance"); }
    Handle inputWriter(backendOutput);
    auto mcp = spawnChild(p.get(L"node"), {p.get(L"backend")}, data, job.value, inputReader.value, log.value);
    CloseHandle(std::exchange(inputReader.value, nullptr));
    if (!waitUntilListening(mcp.value, mcpPort, L"/mcp")) throw std::runtime_error("SCV MCP did not start");
    SetEvent(ready.value);

    Tray tray;
    if (p.json.GetNamedBoolean(L"tray", true)) {
        const auto message = tray.open(stop.value, logs, data) ? "SCV: notification icon registered\r\n" : "SCV: Windows notification area unavailable\r\n";
        DWORD count{};
        WriteFile(log.value, message, static_cast<DWORD>(strlen(message)), &count, nullptr);
    }

    env(L"OLLAMA_HOST", L"127.0.0.1:" + std::to_wstring(ollamaPort));
    env(L"OLLAMA_MODELS", p.get(L"models"));
    env(L"OLLAMA_NO_CLOUD", L"1");
    env(L"OLLAMA_NUM_PARALLEL", L"1");
    const fs::path cache = p.get(L"cache");
    const fs::path ollamaHome = data / L"ollama-profile";
    fs::create_directories(cache / L"tmp");
    fs::create_directories(cache / L"cuda");
    fs::create_directories(ollamaHome / L"AppData" / L"Local");
    fs::create_directories(ollamaHome / L"AppData" / L"Roaming");
    env(L"TMP", (cache / L"tmp").wstring());
    env(L"TEMP", (cache / L"tmp").wstring());
    env(L"CUDA_CACHE_PATH", (cache / L"cuda").wstring());
    env(L"USERPROFILE", ollamaHome.wstring());
    env(L"APPDATA", (ollamaHome / L"AppData" / L"Roaming").wstring());
    env(L"LOCALAPPDATA", (ollamaHome / L"AppData" / L"Local").wstring());
    Handle ollama;
    while (true) {
        const HANDLE wake[] = { stop.value, mcp.value, qdrant.value, embeddings.value };
        const auto changed = MsgWaitForMultipleObjects(4, wake, FALSE, INFINITE, QS_ALLINPUT);
        if (changed == WAIT_OBJECT_0 + 4) {
            MSG message{};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
        } else if (changed == WAIT_OBJECT_0 + 3) {
            if (ollama && WaitForSingleObject(ollama.value, 0) == WAIT_TIMEOUT) continue;
            ResetEvent(ollamaOwned.value);
            if (listening(ollamaPort, L"/api/version")) continue;
            auto started = spawnChild(p.get(L"ollama"), {L"serve"}, data, job.value, nullInput.value, log.value);
            std::swap(started.value, ollama.value);
            SetEvent(ollamaOwned.value);
        } else {
            break;
        }
    }
    ResetEvent(ready.value);
    CloseHandle(std::exchange(inputWriter.value, nullptr));
    WaitForSingleObject(mcp.value, 35000);
    return 0;
}

bool running(const Profile& p) {
    Handle ready(OpenEventW(SYNCHRONIZE, FALSE, (p.name + L"ready").c_str()));
    return ready && WaitForSingleObject(ready.value, 0) == WAIT_OBJECT_0;
}

bool ensureHost(const Profile& p) {
    if (running(p)) return true;
    Handle boot(CreateMutexW(nullptr, FALSE, (p.name + L"boot").c_str()));
    if (!boot) fail("SCV launch lock");
    const auto locked = WaitForSingleObject(boot.value, 25000);
    if (locked != WAIT_OBJECT_0 && locked != WAIT_ABANDONED) return false;
    struct Unlock { HANDLE handle; ~Unlock() { ReleaseMutex(handle); } } unlock{boot.value};
    if (running(p)) return true;
    auto spawned = spawnChild(executable(), {L"--serve", L"--profile", p.path.wstring()}, p.path.parent_path(), nullptr, nullptr, nullptr, true);
    for (int attempt = 0; attempt < 230; ++attempt) {
        if (running(p)) return true;
        if (spawned) {
            if (WaitForSingleObject(spawned.value, 100) != WAIT_TIMEOUT) break;
        } else Sleep(100);
    }
    return false;
}

int sessionStart(const Profile& profile) {
    if (!profile.json.GetNamedBoolean(L"warmPrepared", true)) return 0;
    std::string input(std::istreambuf_iterator<char>(std::cin), {});
    JsonObject hook;
    if (input.size() > 64 * 1024 || !JsonObject::TryParse(to_hstring(input), hook)) return 0;
    fs::path location(std::wstring(hook.GetNamedString(L"cwd", L"")));
    std::error_code error;
    if (!location.is_absolute() || !fs::is_directory(location, error)) return 0;
    if (fs::is_regular_file(location / L".socraticodeignore", error)) {
        // Вложенный новый проект не наследует готовность родительского проекта.
        ensureHost(profile);
    }
    return 0;
}

void writeReply(const JsonObject& reply) {
    std::cout << to_string(reply.Stringify()) << '\n' << std::flush;
}

void relay(const Profile& profile) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    const auto catalog = readObject(profile.get(L"catalog"));
    for (std::string line; std::getline(std::cin, line);) {
        JsonObject request;
        if (line.size() > 4 * 1024 * 1024 || !JsonObject::TryParse(to_hstring(line), request) || !request.HasKey(L"id")) continue;
        JsonObject response;
        response.SetNamedValue(L"jsonrpc", JsonValue::CreateStringValue(L"2.0"));
        response.SetNamedValue(L"id", request.GetNamedValue(L"id"));
        const auto method = request.GetNamedString(L"method", L"");
        const auto params = request.GetNamedObject(L"params", JsonObject{});
        const auto meta = params.GetNamedObject(L"_meta", JsonObject{});
        int errorCode = -32000;
        try {
            if (meta.GetNamedString(L"io.modelcontextprotocol/protocolVersion", L"") != protocol) {
                errorCode = -32022;
                throw std::runtime_error("SocratiCode V requires MCP 2026-07-28");
            }
            if (catalog.HasKey(method)) {
                response.SetNamedValue(L"result", catalog.GetNamedValue(method));
                writeReply(response);
            } else if (method == L"tools/call") {
                if (!ensureHost(profile)) throw std::runtime_error("SocratiCode V startup failed. See its local log.");
                const auto name = std::wstring(params.GetNamedString(L"name"));
                if (name.empty() || name.find_first_not_of(L"abcdefghijklmnopqrstuvwxyz_") != std::wstring::npos)
                    throw std::runtime_error("Invalid SCV tool name");
                const auto headers = L"Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n"
                    L"MCP-Protocol-Version: 2026-07-28\r\nMcp-Method: tools/call\r\nMcp-Name: " + name + L"\r\n";
                const auto body = http(profile.port(L"mcpPort"), L"/mcp", L"POST", headers, line, 300000);
                if (!body.empty() && body.front() == '{') {
                    writeReply(JsonObject::Parse(to_hstring(body)));
                } else {
                    const auto start = body.find("data: ");
                    if (start == std::string::npos) throw std::runtime_error("Unexpected response from SCV MCP");
                    const auto end = body.find('\n', start);
                    writeReply(JsonObject::Parse(to_hstring(body.substr(start + 6, end - start - 6))));
                }
            } else {
                errorCode = -32601;
                throw std::runtime_error("Unknown MCP method");
            }
        } catch (const hresult_error& error) {
            JsonObject payload;
            payload.SetNamedValue(L"code", JsonValue::CreateNumberValue(errorCode));
            payload.SetNamedValue(L"message", JsonValue::CreateStringValue(error.message()));
            response.SetNamedValue(L"error", payload);
            writeReply(response);
        } catch (const std::exception& error) {
            JsonObject payload;
            payload.SetNamedValue(L"code", JsonValue::CreateNumberValue(errorCode));
            payload.SetNamedValue(L"message", JsonValue::CreateStringValue(to_hstring(error.what())));
            response.SetNamedValue(L"error", payload);
            writeReply(response);
        }
    }
}

int wmain(int argc, wchar_t** argv) {
    init_apartment(apartment_type::single_threaded);
    try {
        std::wstring setting(32768, L'\0');
        const auto length = GetEnvironmentVariableW(L"SCV_PROFILE", setting.data(), static_cast<DWORD>(setting.size()));
        if (length >= setting.size()) throw std::runtime_error("SCV_PROFILE is too long");
        setting.resize(length);
        const auto bin = executable().parent_path();
        auto path = bin / L"profile.json";
        if (!setting.empty()) path = setting;
        if (argc == 4 && std::wstring_view(argv[2]) == L"--profile") path = argv[3];
        const Profile profile(path);
        const std::wstring_view mode = argc > 1 ? argv[1] : L"--open";
        if (mode == L"--serve") return serve(profile);
        if (mode == L"--mcp") { relay(profile); return 0; }
        if (mode == L"--session-start") return sessionStart(profile);
        if (mode == L"--open") return ensureHost(profile) ? 0 : 1;
        if (mode == L"--stop") {
            Handle stop(OpenEventW(EVENT_MODIFY_STATE, FALSE, (profile.name + L"stop").c_str()));
            return !stop || SetEvent(stop.value) ? 0 : 1;
        }
        if (mode == L"--ollama") {
            Handle start(OpenEventW(EVENT_MODIFY_STATE, FALSE, (profile.name + L"ollama").c_str()));
            Handle owned(OpenEventW(SYNCHRONIZE, FALSE, (profile.name + L"ollama-owned").c_str()));
            if (!start || !owned || !SetEvent(start.value) || WaitForSingleObject(owned.value, 10000) != WAIT_OBJECT_0) return 1;
            return waitUntilListening(nullptr, profile.port(L"ollamaPort"), L"/api/version") ? 0 : 1;
        }
        return 2;
    } catch (const hresult_error& error) {
        std::cerr << to_string(error.message()) << '\n';
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
    }
    return 1;
}
