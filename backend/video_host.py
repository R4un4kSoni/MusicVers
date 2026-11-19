
from PySide6 import QtCore, QtWidgets


class VideoHostBridge(QtCore.QObject):

    initialize_requested = QtCore.Signal(object)
    show_video_requested = QtCore.Signal()
    hide_video_requested = QtCore.Signal()

    def __init__(self, parent=None):
        super().__init__(parent)

        self.native_window = None
        self.browser = None
        self.video_surface = None
        self.video_handle = None

        self.initialize_requested.connect(
            self._initialize_on_gui_thread,
            QtCore.Qt.ConnectionType.QueuedConnection
        )

        self.show_video_requested.connect(
            self._show_video_on_gui_thread,
            QtCore.Qt.ConnectionType.QueuedConnection
        )

        self.hide_video_requested.connect(
            self._hide_video_on_gui_thread,
            QtCore.Qt.ConnectionType.QueuedConnection
        )

    def request_initialize(self, window):
        self.initialize_requested.emit(window)

    @QtCore.Slot(object)
    def _initialize_on_gui_thread(self, window):

        self.native_window = window.native

        if self.native_window is None:
            print("VideoHost: Native window unavailable.")
            return

        if self.video_surface is not None:
            return

        self.browser = self.native_window.webview

        # Keep WebView's original parent unchanged.
        self.video_surface = NativeVideoSurface(self.browser)

        self.browser.installEventFilter(self)

        self.video_handle = self.video_surface.get_video_handle()

        print("VideoHost: Qt GUI thread initialized.")
        print("VideoHost: Browser parent preserved.")
        print("VideoHost: Native video surface created.")
        print("VideoHost: Video handle:", self.video_handle)
        if hasattr(self, "api"):
            self.api.set_video_handle(self.video_handle)

    def eventFilter(self, watched, event):

        if (
            watched is self.browser
            and event.type() == QtCore.QEvent.Type.Resize
        ):
            self._update_video_geometry()

        return super().eventFilter(watched, event)

    def _update_video_geometry(self):

        if self.browser is None or self.video_surface is None:
            return

        width = self.browser.width()
        height = self.browser.height()

        video_height = height // 2

        self.video_surface.setGeometry(
            0,
            height - video_height,
            width,
            video_height
        )

    def show_video(self):
        self.show_video_requested.emit()

    @QtCore.Slot()
    def _show_video_on_gui_thread(self):

        if self.video_surface is None:
            return

        self._update_video_geometry()
        self.video_surface.show()
        self.video_surface.raise_()

    def hide_video(self):
        self.hide_video_requested.emit()

    @QtCore.Slot()
    def _hide_video_on_gui_thread(self):

        if self.video_surface is not None:
            self.video_surface.hide()


class NativeVideoSurface(QtWidgets.QFrame):

    def __init__(self, parent=None):
        super().__init__(parent)

        self.setObjectName("native-video-surface")

        self.setAttribute(
            QtCore.Qt.WidgetAttribute.WA_NativeWindow,
            True
        )

        self.setAttribute(
            QtCore.Qt.WidgetAttribute.WA_DontCreateNativeAncestors,
            True
        )

        self.setStyleSheet("""
            QFrame#native-video-surface {
                background-color: #000000;
                border: none;
            }
        """)

        self.hide()

    def get_video_handle(self):
        return int(self.winId())
