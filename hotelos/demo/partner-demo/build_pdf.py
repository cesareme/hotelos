#!/usr/bin/env python3
# Generador del PDF "investor deck" de HotelOS.
#
# Diseño:
#   * Tema oscuro coherente con el producto (paleta del admin-web).
#   * Tipografía: Helvetica (built-in en ReportLab), pesos curados.
#   * Una página por escena, con título grande + lead + bullets + mockup vectorial.
#   * Si shots/NN-*.png existe, se usa la imagen real con marco; si no, un mockup vectorial.
#   * Página final: stack + estado + CTA.
#
# Salida: ./HotelOS_Demo.pdf  (formato A4 landscape para que respire)
#
# Uso: python3 build_pdf.py

import os
from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.pdfgen import canvas as canvaspkg
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image,
    Table, TableStyle, Flowable, KeepTogether
)
from reportlab.lib.units import mm, cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# -----------------------------------------------------------------------------
# Paleta (espejo de los tokens del admin-web dark)
# -----------------------------------------------------------------------------
BG       = HexColor("#0a0d10")
SURFACE  = HexColor("#11161b")
SURFACE2 = HexColor("#1a2128")
INK      = HexColor("#e8eef3")
INK_MUTE = HexColor("#93a1ad")
ACCENT   = HexColor("#4ee0a3")
ACCENT_S = HexColor("#1a3a2a")
BORDER   = HexColor("#232b33")
WARN     = HexColor("#f0b46a")
ERR      = HexColor("#ef6b6b")
INFO     = HexColor("#7aa9ff")

# Layout (A4 landscape: 297mm x 210mm)
PAGE_W, PAGE_H = landscape(A4)
MARGIN = 18 * mm

ROOT = Path(__file__).resolve().parent
SHOTS_DIR = ROOT / "shots"
OUT_PDF = ROOT / "HotelOS_Demo.pdf"

# -----------------------------------------------------------------------------
# Estilos
# -----------------------------------------------------------------------------
styles = getSampleStyleSheet()

def style(name, **kwargs):
    base = ParagraphStyle(name=name, parent=styles["Normal"])
    for k, v in kwargs.items():
        setattr(base, k, v)
    return base

S_EYEBROW   = style("eyebrow",   fontName="Helvetica-Bold", fontSize=9, textColor=ACCENT, leading=11, spaceAfter=4)
S_H1        = style("h1",        fontName="Helvetica-Bold", fontSize=42, textColor=INK, leading=46, spaceAfter=10)
S_H2        = style("h2",        fontName="Helvetica-Bold", fontSize=28, textColor=INK, leading=32, spaceAfter=8)
S_H3        = style("h3",        fontName="Helvetica-Bold", fontSize=16, textColor=INK, leading=20, spaceAfter=6)
S_LEAD      = style("lead",      fontName="Helvetica", fontSize=14, textColor=INK_MUTE, leading=20, spaceAfter=10)
S_BODY      = style("body",      fontName="Helvetica", fontSize=11, textColor=INK, leading=15, spaceAfter=6)
S_BODY_MUTE = style("body_mute", fontName="Helvetica", fontSize=10, textColor=INK_MUTE, leading=14, spaceAfter=4)
S_BULLET    = style("bullet",    fontName="Helvetica", fontSize=11, textColor=INK, leading=16, leftIndent=14, bulletIndent=0, spaceAfter=2)
S_PUNCH     = style("punch",     fontName="Helvetica-Oblique", fontSize=14, textColor=ACCENT, leading=18, leftIndent=10, spaceAfter=4)
S_SMALL     = style("small",     fontName="Helvetica", fontSize=8, textColor=INK_MUTE, leading=10)
S_TAG       = style("tag",       fontName="Helvetica-Bold", fontSize=8, textColor=INK_MUTE, leading=10)
S_CTA_LARGE = style("cta",       fontName="Helvetica-Bold", fontSize=18, textColor=INK, leading=22, alignment=TA_CENTER)


# -----------------------------------------------------------------------------
# Fondos y decoración de página
# -----------------------------------------------------------------------------
def draw_dark_background(c, doc):
    c.saveState()
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # Footer
    c.setFillColor(INK_MUTE)
    c.setFont("Helvetica", 8)
    c.drawString(MARGIN, 10 * mm, "HotelOS · Demo para socio · Confidencial")
    c.drawRightString(PAGE_W - MARGIN, 10 * mm, f"{c.getPageNumber():02d}")
    # Top brand bar
    c.setFillColor(ACCENT)
    c.rect(MARGIN, PAGE_H - 14 * mm, 14 * mm, 1.2 * mm, stroke=0, fill=1)
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(INK)
    c.drawString(MARGIN + 18 * mm, PAGE_H - 14 * mm, "HOTELOS")
    c.restoreState()


def draw_cover_background(c, doc):
    c.saveState()
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # Big gradient-ish accent block bottom-right
    c.setFillColor(ACCENT_S)
    c.circle(PAGE_W - 30 * mm, 50 * mm, 80 * mm, stroke=0, fill=1)
    c.setFillColor(BG)
    c.circle(PAGE_W - 30 * mm, 50 * mm, 70 * mm, stroke=0, fill=1)
    c.restoreState()


# -----------------------------------------------------------------------------
# Custom flowables
# -----------------------------------------------------------------------------
class Hr(Flowable):
    def __init__(self, w=None, color=BORDER, thickness=0.5, space_before=4, space_after=8):
        Flowable.__init__(self)
        self.w = w
        self.color = color
        self.thickness = thickness
        self.space_before = space_before
        self.space_after = space_after

    def wrap(self, w, h):
        self.width = self.w or w
        self.height = self.thickness + self.space_before + self.space_after
        return self.width, self.height

    def draw(self):
        c = self.canv
        c.setStrokeColor(self.color)
        c.setLineWidth(self.thickness)
        y = self.space_after
        c.line(0, y, self.width, y)


class Pill(Flowable):
    def __init__(self, label, value=None, color=ACCENT, w=46*mm, h=14*mm):
        Flowable.__init__(self)
        self.label = label
        self.value = value
        self.color = color
        self.width = w
        self.height = h

    def wrap(self, w, h):
        return self.width, self.height

    def draw(self):
        c = self.canv
        c.setStrokeColor(BORDER)
        c.setFillColor(SURFACE)
        c.roundRect(0, 0, self.width, self.height, 4, stroke=1, fill=1)
        # Color dot
        c.setFillColor(self.color)
        c.circle(4 * mm, self.height / 2, 1.4 * mm, stroke=0, fill=1)
        # Label
        c.setFont("Helvetica-Bold", 8)
        c.setFillColor(INK)
        if self.value is not None:
            c.drawString(8 * mm, self.height / 2 + 0.4 * mm, str(self.value))
            c.setFont("Helvetica", 7)
            c.setFillColor(INK_MUTE)
            c.drawString(8 * mm, self.height / 2 - 4 * mm, str(self.label).upper())
        else:
            c.drawString(8 * mm, self.height / 2 - 1.5 * mm, str(self.label))


class ShotOrMock(Flowable):
    """Renderiza un screenshot si existe (shots/NN-name.png), o un mockup vectorial."""
    def __init__(self, shot_path, mock_fn, w, h):
        Flowable.__init__(self)
        self.shot_path = shot_path
        self.mock_fn = mock_fn
        self.width = w
        self.height = h

    def wrap(self, w, h):
        return self.width, self.height

    def draw(self):
        c = self.canv
        # Frame
        c.setFillColor(SURFACE)
        c.setStrokeColor(BORDER)
        c.roundRect(0, 0, self.width, self.height, 4 * mm, stroke=1, fill=1)
        if self.shot_path and Path(self.shot_path).exists():
            # Embed image, fit within padding
            pad = 3 * mm
            from PIL import Image as PILImage
            try:
                img = PILImage.open(self.shot_path)
                iw, ih = img.size
                # Available area
                aw = self.width - 2 * pad
                ah = self.height - 2 * pad
                ratio = min(aw / iw, ah / ih)
                draw_w = iw * ratio
                draw_h = ih * ratio
                x = (self.width - draw_w) / 2
                y = (self.height - draw_h) / 2
                c.drawImage(str(self.shot_path), x, y, width=draw_w, height=draw_h,
                            preserveAspectRatio=True, mask='auto')
                return
            except Exception:
                pass
        # Fallback: vector mockup
        if self.mock_fn:
            self.mock_fn(c, self.width, self.height)


# -----------------------------------------------------------------------------
# Mockups vectoriales (fallback elegante por escena)
# -----------------------------------------------------------------------------
def mock_kpi_grid(c, w, h, kpis):
    """Grid de KPI cards. kpis = [(label, value, color), ...]"""
    pad = 6 * mm
    cols = min(len(kpis), 3)
    rows = (len(kpis) + cols - 1) // cols
    gap = 3 * mm
    cw = (w - 2 * pad - (cols - 1) * gap) / cols
    ch = 24 * mm
    for i, (label, value, color) in enumerate(kpis):
        col = i % cols
        row = i // cols
        x = pad + col * (cw + gap)
        y = h - pad - (row + 1) * ch - row * gap
        # Card
        c.setFillColor(SURFACE2)
        c.setStrokeColor(BORDER)
        c.roundRect(x, y, cw, ch, 3 * mm, stroke=1, fill=1)
        # Left accent
        c.setFillColor(color)
        c.rect(x, y, 1.5 * mm, ch, stroke=0, fill=1)
        # Label
        c.setFont("Helvetica-Bold", 7)
        c.setFillColor(INK_MUTE)
        c.drawString(x + 4 * mm, y + ch - 6 * mm, label.upper())
        # Value
        c.setFont("Helvetica-Bold", 18)
        c.setFillColor(INK)
        c.drawString(x + 4 * mm, y + 5 * mm, str(value))

def mock_mi_dia(c, w, h):
    mock_kpi_grid(c, w, h, [
        ("Llegadas hoy", "14", ACCENT),
        ("Salidas hoy", "14", ACCENT),
        ("En el hotel", "20", ACCENT),
        ("Sin habitación", "14", WARN),
        ("Salidas con retraso", "0", ACCENT),
        ("Saldo pendiente", "584 €", WARN),
    ])
    # Mini "Llegadas de hoy" rows in the lower band
    base_y = 6 * mm
    c.setFont("Helvetica-Bold", 7); c.setFillColor(INK_MUTE)
    c.drawString(6 * mm, base_y + 14 * mm, "LLEGADAS DE HOY · 14 RESERVAS")
    headers = ["HUÉSPED", "HABITACIÓN", "TIPO", "ESTADO", "SALDO"]
    cw = (w - 12 * mm) / len(headers)
    c.setFont("Helvetica-Bold", 7)
    for i, hd in enumerate(headers):
        c.drawString(6 * mm + i * cw, base_y + 8 * mm, hd)
    # rows
    rows = [("María López", "204", "Doble superior", "Confirmada", "234 €"),
            ("Carlos Ruiz", "Sin asignar", "Doble estándar", "Confirmada", "0 €")]
    for ri, row in enumerate(rows):
        ry = base_y + 0.5 * mm - ri * 4 * mm
        c.setFont("Helvetica", 7); c.setFillColor(INK)
        for ci, v in enumerate(row):
            c.drawString(6 * mm + ci * cw, ry + 3 * mm, str(v))

def mock_search(c, w, h):
    # Modal palette mockup
    mx = w * 0.18
    my = h * 0.18
    mw = w - 2 * mx
    mh = h - 2 * my
    c.setFillColor(SURFACE2)
    c.setStrokeColor(BORDER)
    c.roundRect(mx, my, mw, mh, 4 * mm, stroke=1, fill=1)
    # Input
    c.setFillColor(SURFACE)
    c.roundRect(mx + 4 * mm, my + mh - 14 * mm, mw - 8 * mm, 10 * mm, 2 * mm, stroke=1, fill=1)
    c.setFont("Helvetica", 12)
    c.setFillColor(INK)
    c.drawString(mx + 8 * mm, my + mh - 9 * mm, "Petrova")
    # Section
    c.setFont("Helvetica-Bold", 7)
    c.setFillColor(INK_MUTE)
    c.drawString(mx + 4 * mm, my + mh - 20 * mm, "RESERVAS")
    # Result rows
    results = [
        ("RVNX-01861", "Nina Petrova · 2026-08-23 → 2026-08-26 · booking.com"),
        ("RVNX-01860", "Nina Petrova · 2026-08-23 → 2026-08-26 · expedia"),
        ("RVNX-01850", "Nina Petrova · 2026-08-22 → 2026-08-23 · wholesaler"),
        ("RVNX-01831", "Nina Petrova · 2026-08-21 → 2026-08-22 · direct"),
    ]
    for i, (code, subt) in enumerate(results):
        ry = my + mh - 30 * mm - i * 8 * mm
        c.setFillColor(SURFACE if i else ACCENT_S)
        c.rect(mx + 4 * mm, ry - 1 * mm, mw - 8 * mm, 7 * mm, stroke=0, fill=1)
        c.setFont("Helvetica-Bold", 9)
        c.setFillColor(INK)
        c.drawString(mx + 7 * mm, ry + 2 * mm, code)
        c.setFont("Helvetica", 7)
        c.setFillColor(INK_MUTE)
        c.drawString(mx + 32 * mm, ry + 2 * mm, subt)
        # confirmed badge
        c.setFillColor(ACCENT)
        c.circle(mx + 28 * mm, ry + 3.5 * mm, 1 * mm, stroke=0, fill=1)

def mock_timeline(c, w, h):
    pad = 5 * mm
    # Header
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(INK_MUTE)
    days = ["mar 26", "mié 27", "jue 28", "vie 29", "sáb 30", "dom 31", "lun 01"]
    col_w = (w - 2 * pad - 22 * mm) / len(days)
    for i, d in enumerate(days):
        c.drawString(pad + 22 * mm + i * col_w + 2 * mm, h - pad - 6 * mm, d)
    # Rows
    rows = 6
    rh = (h - pad * 2 - 12 * mm) / rows
    bookings = [
        (0, 1, 3, "David Chen", "731 €"),
        (1, 0, 2, "James D.", "—"),
        (1, 2, 2, "Nina Petrova", "270 €"),
        (2, 3, 2, "María López", "195 €"),
        (3, 1, 1, "Acme Tours", "—"),
        (3, 2, 2, "Elena Sanz", "334 €"),
        (4, 4, 3, "Sophie Martin", "271 €"),
        (5, 1, 4, "Aisha Khan", "1 162 €"),
    ]
    palette = [INFO, ACCENT, WARN, INFO, ACCENT, INFO, WARN, ACCENT]
    for i in range(rows):
        ry = h - pad - 12 * mm - (i + 1) * rh
        if i % 2 == 0:
            c.setFillColor(SURFACE2)
            c.rect(pad, ry, w - 2 * pad, rh, stroke=0, fill=1)
        c.setFillColor(INK_MUTE)
        c.setFont("Helvetica", 8)
        c.drawString(pad + 2 * mm, ry + rh / 2 - 1 * mm, f"Hab. 1{i+3:02d}")
    for i, (row, start, span, name, price) in enumerate(bookings):
        if row >= rows: continue
        ry = h - pad - 12 * mm - (row + 1) * rh + 2
        bx = pad + 22 * mm + start * col_w + 1
        bw = span * col_w - 2
        bh = rh - 4
        c.setFillColor(palette[i % len(palette)])
        c.roundRect(bx, ry, bw, bh, 1.5 * mm, stroke=0, fill=1)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 7)
        c.drawString(bx + 1.5 * mm, ry + bh - 5, name[:18])
        c.setFont("Helvetica", 6)
        c.drawString(bx + 1.5 * mm, ry + 1.5, price)

def mock_folios(c, w, h):
    # Two folio tables
    pad = 6 * mm
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(INK_MUTE)
    c.drawString(pad, h - 8 * mm, "FOLIOS DE LA RESERVA")
    # Table headers
    headers = ["ETIQUETA", "TIPO", "ESTADO", "MONEDA", "CARGOS", "PENDIENTE"]
    cell_w = (w - 2 * pad) / len(headers)
    c.setFont("Helvetica-Bold", 7)
    for i, hd in enumerate(headers):
        c.drawString(pad + i * cell_w, h - 14 * mm, hd)
    # rows
    rows = [
        ("guest", "principal", "open", "EUR", "275,00 €", "275,00 €"),
        ("company", "secundario", "open", "EUR", "24,00 €", "24,00 €"),
    ]
    for ri, row in enumerate(rows):
        ry = h - 22 * mm - ri * 8 * mm
        c.setFillColor(SURFACE2 if ri % 2 == 0 else SURFACE)
        c.rect(pad, ry, w - 2 * pad, 7 * mm, stroke=0, fill=1)
        c.setFont("Helvetica-Bold", 9)
        c.setFillColor(INK)
        c.drawString(pad, ry + 2 * mm, row[0])
        c.setFont("Helvetica", 8)
        c.setFillColor(INK_MUTE)
        for ci, v in enumerate(row[1:], start=1):
            c.drawString(pad + ci * cell_w, ry + 2 * mm, v)
    # Rules section
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(INK_MUTE)
    c.drawString(pad, h - 50 * mm, "REGLAS DE ENRUTAMIENTO")
    c.setFillColor(ACCENT_S)
    c.roundRect(pad, h - 64 * mm, w - 2 * pad, 9 * mm, 2 * mm, stroke=0, fill=1)
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(INK)
    c.drawString(pad + 4 * mm, h - 60 * mm, "minibar → company")
    c.setFont("Helvetica", 8)
    c.setFillColor(INK_MUTE)
    c.drawString(pad + 60 * mm, h - 60 * mm, "prioridad 0 · activa · F&B/minibar a la empresa")

def mock_housekeeping(c, w, h):
    pad = 6 * mm
    states = [
        ("Sucia", "limpiar", ERR),
        ("Limpia", "lista", ACCENT),
        ("Inspeccionada", "vendible", INFO),
        ("Fuera de servicio", "ninguna", INK_MUTE),
    ]
    pillw = (w - 2 * pad - 9 * mm) / len(states)
    for i, (lbl, sub, col) in enumerate(states):
        x = pad + i * (pillw + 3 * mm)
        c.setFillColor(SURFACE2); c.setStrokeColor(BORDER)
        c.roundRect(x, h - 25 * mm, pillw, 18 * mm, 2 * mm, stroke=1, fill=1)
        c.setFillColor(col); c.rect(x, h - 25 * mm, 1 * mm, 18 * mm, stroke=0, fill=1)
        c.setFont("Helvetica-Bold", 7); c.setFillColor(INK_MUTE)
        c.drawString(x + 3 * mm, h - 12 * mm, lbl.upper())
        c.setFont("Helvetica-Bold", 18); c.setFillColor(INK)
        c.drawString(x + 3 * mm, h - 22 * mm, str([17, 12, 12, 0][i]))
    # Room grid
    rooms = [
        ("103", "Sucia", ERR), ("104", "Limpia", ACCENT),
        ("105", "Inspec.", INFO), ("106", "Ocupada", WARN),
        ("107", "Sucia", ERR), ("108", "Limpia", ACCENT),
        ("109", "Inspec.", INFO), ("110", "Sucia", ERR),
    ]
    rc = 4
    rrw = (w - 2 * pad - (rc - 1) * 3 * mm) / rc
    rrh = 16 * mm
    for i, (num, lbl, col) in enumerate(rooms):
        col_i = i % rc; row_i = i // rc
        x = pad + col_i * (rrw + 3 * mm)
        y = h - 32 * mm - (row_i + 1) * rrh - row_i * 3 * mm
        c.setFillColor(SURFACE2); c.setStrokeColor(BORDER)
        c.roundRect(x, y, rrw, rrh, 2 * mm, stroke=1, fill=1)
        c.setFont("Helvetica-Bold", 14); c.setFillColor(INK)
        c.drawString(x + 3 * mm, y + rrh - 7 * mm, num)
        c.setFillColor(col); c.circle(x + rrw - 4 * mm, y + rrh - 4 * mm, 1.4 * mm, stroke=0, fill=1)
        c.setFont("Helvetica", 7); c.setFillColor(INK_MUTE)
        c.drawString(x + 3 * mm, y + 3 * mm, lbl)

def mock_maintenance(c, w, h):
    mock_kpi_grid(c, w, h, [
        ("Emergencias", "1", ERR),
        ("Abiertas", "5", WARN),
        ("En curso", "2", INFO),
        ("Esperando proveedor", "0", INK_MUTE),
        ("Habitación bloqueada", "3", ERR),
        ("Resueltas (24h)", "2", ACCENT),
    ])
    # Order rows in the bottom band — keep it tight, 2 orders, single line each.
    orders = [
        ("Fuga de agua en baño", "Hab. 108 · habitación bloqueada", ERR),
        ("Cerradura electrónica no responde", "Hab. 111 · asignada", WARN),
    ]
    band_top = h - 58 * mm
    row_h = 9 * mm
    gap = 2 * mm
    c.setFont("Helvetica-Bold", 7); c.setFillColor(INK_MUTE)
    c.drawString(6 * mm, band_top, "ÓRDENES ACTIVAS · TOP 2")
    for i, (title, sub, col) in enumerate(orders):
        y = band_top - 4 * mm - (i + 1) * row_h - i * gap
        c.setFillColor(SURFACE2); c.setStrokeColor(BORDER)
        c.roundRect(6 * mm, y, w - 12 * mm, row_h, 1.5 * mm, stroke=1, fill=1)
        c.setFillColor(col); c.rect(6 * mm, y, 1.5 * mm, row_h, stroke=0, fill=1)
        c.setFont("Helvetica-Bold", 9); c.setFillColor(INK)
        c.drawString(10 * mm, y + row_h - 4 * mm, title)
        c.setFont("Helvetica", 7); c.setFillColor(INK_MUTE)
        c.drawString(10 * mm, y + 1.8 * mm, sub)

def mock_compliance(c, w, h):
    mock_kpi_grid(c, w, h, [
        ("% cumplimiento", "53%", ACCENT),
        ("Críticos abiertos", "3", ERR),
        ("Vencidos", "5", WARN),
        ("Vencen <30 d", "9", WARN),
        ("Pendientes / no cumple", "10", ERR),
        ("Áreas activas", "15", ACCENT),
    ])
    # Areas — bottom band of the flowable, only top 4 to avoid overflow.
    areas = [
        ("Licencias y urbanismo", "3/4", 1),
        ("Turismo y clasificación", "2/4", 1),
        ("Protección de datos", "2/5", 1),
        ("Laboral y SS", "3/6", 1),
    ]
    band_top = h - 58 * mm
    rh = 5.5 * mm
    c.setFont("Helvetica-Bold", 7); c.setFillColor(INK_MUTE)
    c.drawString(6 * mm, band_top, "POR ÁREA · 15 ACTIVAS · TOP 4")
    for i, (area, ratio, crit) in enumerate(areas):
        y = band_top - 4 * mm - (i + 1) * rh
        c.setFillColor(SURFACE2 if i % 2 == 0 else SURFACE)
        c.rect(6 * mm, y, w - 12 * mm, rh, stroke=0, fill=1)
        c.setFont("Helvetica", 8); c.setFillColor(INK)
        c.drawString(10 * mm, y + 1.5 * mm, area)
        c.setFillColor(INK_MUTE); c.setFont("Helvetica-Bold", 8)
        c.drawRightString(w - 22 * mm, y + 1.5 * mm, ratio)
        if crit:
            c.setFillColor(ERR); c.circle(w - 14 * mm, y + rh / 2, 1.2 * mm, stroke=0, fill=1)

def mock_revenue(c, w, h):
    mock_kpi_grid(c, w, h, [
        ("OTB 30d", "1 078 noches", ACCENT),
        ("Pace 90d", "+775 noches", ACCENT),
        ("Pickup 7d", "945 noches", ACCENT),
        ("Forecast (ocup.)", "91.54 %", INFO),
        ("Ocupación mes", "73,3 %", ACCENT),
        ("ADR mes", "137,52 €", ACCENT),
    ])
    # Mini line chart
    c.setFillColor(SURFACE2); c.setStrokeColor(BORDER)
    chart_x = 6 * mm; chart_y = 6 * mm; chart_w = w - 12 * mm; chart_h = 50 * mm
    c.roundRect(chart_x, chart_y, chart_w, chart_h, 2 * mm, stroke=1, fill=1)
    c.setFont("Helvetica-Bold", 8); c.setFillColor(INK_MUTE)
    c.drawString(chart_x + 4 * mm, chart_y + chart_h - 5 * mm, "PACE / PICKUP 90 DÍAS")
    # Forecast vs actual lines
    import math
    n = 50
    pts_act = []
    pts_fc = []
    for i in range(n):
        x = chart_x + 6 * mm + i * (chart_w - 12 * mm) / (n - 1)
        a = chart_y + 8 * mm + 30 * mm * (0.5 + 0.4 * math.sin(i / 5) + i / n * 0.2)
        f = chart_y + 8 * mm + 30 * mm * (0.55 + 0.35 * math.sin(i / 5 + 0.5) + i / n * 0.25)
        pts_act.append((x, a))
        pts_fc.append((x, f))
    c.setStrokeColor(ACCENT); c.setLineWidth(1.4)
    p = c.beginPath()
    p.moveTo(*pts_act[0])
    for pt in pts_act[1:]:
        p.lineTo(*pt)
    c.drawPath(p)
    c.setStrokeColor(INFO); c.setLineWidth(1.1); c.setDash(2, 2)
    p = c.beginPath()
    p.moveTo(*pts_fc[0])
    for pt in pts_fc[1:]:
        p.lineTo(*pt)
    c.drawPath(p)
    c.setDash()
    # Legend
    c.setFont("Helvetica", 7); c.setFillColor(ACCENT)
    c.rect(chart_x + chart_w - 50 * mm, chart_y + 4 * mm, 4 * mm, 1.2 * mm, stroke=0, fill=1)
    c.setFillColor(INK); c.drawString(chart_x + chart_w - 44 * mm, chart_y + 3.5 * mm, "Actual")
    c.setFillColor(INFO)
    c.rect(chart_x + chart_w - 26 * mm, chart_y + 4 * mm, 4 * mm, 1.2 * mm, stroke=0, fill=1)
    c.setFillColor(INK); c.drawString(chart_x + chart_w - 20 * mm, chart_y + 3.5 * mm, "Forecast")

def mock_channel_manager(c, w, h):
    channels = [
        ("Booking.com", "active", ACCENT),
        ("Expedia", "active", ACCENT),
        ("Airbnb", "syncing", WARN),
        ("Hotelbeds", "active", ACCENT),
        ("Vrbo", "inactive", INK_MUTE),
    ]
    pad = 6 * mm
    ch = 18 * mm
    cw = (w - 2 * pad - (len(channels) - 1) * 3 * mm) / len(channels)
    for i, (name, status, col) in enumerate(channels):
        x = pad + i * (cw + 3 * mm)
        y = h - 30 * mm
        c.setFillColor(SURFACE2); c.setStrokeColor(BORDER)
        c.roundRect(x, y, cw, ch, 2 * mm, stroke=1, fill=1)
        c.setFillColor(col); c.circle(x + 4 * mm, y + ch - 4 * mm, 1.5 * mm, stroke=0, fill=1)
        c.setFont("Helvetica-Bold", 9); c.setFillColor(INK)
        c.drawString(x + 4 * mm, y + 9 * mm, name)
        c.setFont("Helvetica", 7); c.setFillColor(INK_MUTE)
        c.drawString(x + 4 * mm, y + 4 * mm, status)
    # Sync stats
    stats = [("Mappings", "12 room types"), ("Tarifas", "5 plans"), ("Última sync", "hace 2 min"), ("Reservas 24h", "37")]
    y0 = h - 55 * mm
    for i, (lbl, v) in enumerate(stats):
        x = pad + i * ((w - 2 * pad) / 4)
        c.setFont("Helvetica-Bold", 7); c.setFillColor(INK_MUTE)
        c.drawString(x, y0, lbl.upper())
        c.setFont("Helvetica-Bold", 14); c.setFillColor(INK)
        c.drawString(x, y0 - 7 * mm, v)

def mock_hitl(c, w, h):
    mock_kpi_grid(c, w, h, [
        ("Pendientes", "3", WARN),
        ("Fuera de plazo", "3", ERR),
        ("Aprobadas (24h)", "0", ACCENT),
        ("Rechazadas (24h)", "0", INK_MUTE),
        ("Resolución media", "44 min", INFO),
        ("Confianza media", "82 %", ACCENT),
    ])
    items = [
        ("Rate Recommendation", "rate_plan · RATE_BAR_DOUBLE", "40h 17m", "PENDIENTE"),
        ("Invoice Issue", "invoice · INV_2026_0481", "38h 19m", "PENDIENTE"),
    ]
    band_top = h - 58 * mm
    row_h = 9 * mm
    gap = 2 * mm
    c.setFont("Helvetica-Bold", 7); c.setFillColor(INK_MUTE)
    c.drawString(6 * mm, band_top, "COLA HITL · 3 PENDIENTES · TOP 2")
    for i, (t, ent, age, st) in enumerate(items):
        y = band_top - 4 * mm - (i + 1) * row_h - i * gap
        c.setFillColor(SURFACE2); c.setStrokeColor(BORDER)
        c.roundRect(6 * mm, y, w - 12 * mm, row_h, 1.5 * mm, stroke=1, fill=1)
        c.setFont("Helvetica-Bold", 9); c.setFillColor(INK)
        c.drawString(10 * mm, y + row_h - 4 * mm, t)
        c.setFont("Helvetica", 7); c.setFillColor(INK_MUTE)
        c.drawString(10 * mm, y + 1.5 * mm, ent)
        c.setFont("Helvetica", 8); c.setFillColor(WARN)
        c.drawRightString(w - 8 * mm, y + 2.5 * mm, age + "  ·  " + st)

def mock_allotments(c, w, h):
    operators = [("FTI", "FTI Touristik", "20%", "30 d"),
                 ("HBED", "Hotelbeds", "18%", "30 d"),
                 ("JETT", "JetTours", "17%", "30 d"),
                 ("TUI",  "TUI Group", "22%", "45 d")]
    pad = 6 * mm
    c.setFont("Helvetica-Bold", 8); c.setFillColor(INK_MUTE)
    c.drawString(pad, h - 8 * mm, "TOUR OPERADORES")
    headers = ["CODE", "NOMBRE", "COMISIÓN", "PLAZO"]
    cell_w = (w - 2 * pad) / len(headers)
    c.setFont("Helvetica-Bold", 7)
    for i, hd in enumerate(headers):
        c.drawString(pad + i * cell_w, h - 14 * mm, hd)
    for ri, row in enumerate(operators):
        ry = h - 22 * mm - ri * 8 * mm
        c.setFillColor(SURFACE2 if ri % 2 == 0 else SURFACE)
        c.rect(pad, ry, w - 2 * pad, 7 * mm, stroke=0, fill=1)
        c.setFont("Helvetica-Bold", 9); c.setFillColor(INK)
        c.drawString(pad, ry + 2 * mm, row[0])
        c.setFont("Helvetica", 9); c.setFillColor(INK_MUTE)
        for ci, v in enumerate(row[1:], start=1):
            c.drawString(pad + ci * cell_w, ry + 2 * mm, v)

def mock_fnb(c, w, h):
    mock_kpi_grid(c, w, h, [
        ("Referencias en stock", "9", ACCENT),
        ("Stock bajo", "0", ACCENT),
        ("Platos / bebidas", "6", INFO),
        ("Puntos de venta", "3", INFO),
        ("Recetas activas", "6", ACCENT),
        ("Margen medio", "62 %", ACCENT),
    ])
    items = [("Aceite oliva virgen extra", "15 L"),
             ("Agua mineral (1 L)", "120 botellas"),
             ("Café molido", "9,98 kg"),
             ("Leche entera UHT", "49,46 L")]
    band_top = h - 58 * mm
    rh = 5.5 * mm
    c.setFont("Helvetica-Bold", 7); c.setFillColor(INK_MUTE)
    c.drawString(6 * mm, band_top, "INVENTARIO ACTIVO · TOP 4")
    for i, (ref, qty) in enumerate(items):
        y = band_top - 4 * mm - (i + 1) * rh
        c.setFillColor(SURFACE2 if i % 2 == 0 else SURFACE)
        c.rect(6 * mm, y, w - 12 * mm, rh, stroke=0, fill=1)
        c.setFont("Helvetica", 8); c.setFillColor(INK)
        c.drawString(10 * mm, y + 1.5 * mm, ref)
        c.setFillColor(ACCENT); c.setFont("Helvetica-Bold", 8)
        c.drawRightString(w - 10 * mm, y + 1.5 * mm, qty)


# -----------------------------------------------------------------------------
# Páginas
# -----------------------------------------------------------------------------
def build():
    print(f"Building {OUT_PDF}...")
    doc = SimpleDocTemplate(
        str(OUT_PDF),
        pagesize=landscape(A4),
        topMargin=MARGIN,
        bottomMargin=MARGIN,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        title="HotelOS — Demo para socio",
        author="HotelOS",
        subject="PMS+ERP nativo de IA para hoteles independientes españoles",
    )

    story = []

    # --- Cover ----------------------------------------------------------------
    story.append(Spacer(1, 30 * mm))
    story.append(Paragraph("DEMO PARA SOCIO · CONFIDENCIAL · MAYO 2026", S_EYEBROW))
    story.append(Paragraph("HotelOS", style("h_cover", fontName="Helvetica-Bold", fontSize=72, textColor=INK, leading=78, spaceAfter=16)))
    story.append(Paragraph("El PMS + ERP nativo de IA para hoteles independientes españoles.", style("subtitle", fontName="Helvetica", fontSize=20, textColor=INK_MUTE, leading=28, spaceAfter=24)))

    # Pillbar
    pillbar = Table([[
        Pill("RESERVAS DEMO", "1 888"),
        Pill("HABITACIONES", "47"),
        Pill("PROPIEDADES", "4"),
        Pill("PANTALLAS", "30+"),
        Pill("CI", "verde"),
    ]], colWidths=[48*mm]*5)
    pillbar.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "TOP")]))
    story.append(pillbar)

    story.append(Spacer(1, 60 * mm))
    story.append(Paragraph("Una sola plataforma. PMS · Channel Manager · Revenue · ERP · Compliance · IA.", style("cover_tag", fontName="Helvetica-Oblique", fontSize=13, textColor=ACCENT, leading=18)))
    story.append(PageBreak())

    # --- Problem & Solution ---------------------------------------------------
    story.append(Paragraph("EL PROBLEMA", S_EYEBROW))
    story.append(Paragraph("Cuatro herramientas, ninguna conectada, normativa española manual.", S_H2))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(
        "Los hoteles independientes españoles (3–150 habitaciones) viven con un PMS legacy "
        "(Avalon, FideloHotel) + Channel Manager (SiteMinder) + Revenue Manager + ERP "
        "financiero (A3, Sage) + capa de cumplimiento (SES Hospedajes / parte de viajeros) "
        "<b>manualmente conectados</b>. El staff pierde 4–6 h al día en tareas repetitivas.",
        S_LEAD,
    ))
    story.append(Paragraph(
        "Las alternativas modernas (Cloudbeds, Mews, Apaleo) son anglosajonas: cumplimiento "
        "español inexistente o vía partners, sin VeriFactu integrado, sin parte de viajeros "
        "nativo, sin modelos AEAT.",
        S_LEAD,
    ))
    story.append(Hr())
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("LA SOLUCIÓN", S_EYEBROW))
    story.append(Paragraph("Una plataforma que reemplaza seis y ya habla español.", S_H2))

    # Modules table
    mod_data = [
        ["MÓDULO", "QUÉ HACE", "REEMPLAZA A"],
        ["PMS", "Reservas, folios divididos, check-in/out, parte de viajeros", "Opera, Mews, FideloHotel"],
        ["Channel Manager", "Sync con Booking, Expedia, Airbnb, Hotelbeds, Vrbo", "SiteMinder, RateGain"],
        ["Revenue", "Pace/pickup, forecast, BAR, rate shopper, presupuesto", "IDeaS, Duetto, RoomPriceGenie"],
        ["Operaciones", "Pisos, mantenimiento, personal, seguridad, TPV, F&B", "Quore, hotelkit"],
        ["Finanzas", "VeriFactu, conciliación, P&L, modelos AEAT", "A3, Sage"],
        ["Compliance", "~70 controles por CCAA, vault documental", "Consultoría externa"],
        ["IA aplicada", "OCR, parsing email, drafts, HITL", "categoría nueva"],
    ]
    mod_tbl = Table(mod_data, colWidths=[40*mm, 110*mm, 90*mm], rowHeights=[8*mm] + [7.5*mm]*7)
    mod_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), SURFACE2),
        ("BACKGROUND", (0,1), (-1,-1), SURFACE),
        ("TEXTCOLOR", (0,0), (-1,0), ACCENT),
        ("TEXTCOLOR", (0,1), (-1,-1), INK),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,0), 8),
        ("FONTNAME", (0,1), (0,-1), "Helvetica-Bold"),
        ("FONTSIZE", (0,1), (-1,-1), 9),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
        ("LINEBELOW", (0,0), (-1,0), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [SURFACE, SURFACE2]),
    ]))
    story.append(mod_tbl)
    story.append(PageBreak())

    # --- Escenas --------------------------------------------------------------
    scenes = [
        {
            "num": 1, "section": "RECEPCIÓN · MI DÍA",
            "title": "La portada de trabajo de la recepcionista.",
            "lead": "Lo primero que ve al entrar: llegadas, salidas, huéspedes en hotel, cobros pendientes. No es un dashboard de marketing — es la ficha del día.",
            "bullets": [
                "<b>14 llegadas, 14 salidas, 20 huéspedes en hotel</b> hoy.",
                "<b>14 reservas sin habitación asignada</b> y <b>584 € pendientes de cobro</b> destacados.",
                "Cada llegada lleva <b>Hacer check-in</b> y <b>Ver folio</b>. Cero clics intermedios.",
            ],
            "punch": "No es un dashboard de marketing. Es la portada de trabajo.",
            "shot": "01-mi-dia.png", "mock": mock_mi_dia,
        },
        {
            "num": 2, "section": "BÚSQUEDA GLOBAL · ⌘K",
            "title": "Encuentra cualquier cosa en dos segundos.",
            "lead": "Un único cuadro indexa reservas, huéspedes, habitaciones, folios, facturas, propiedades y tarifas. Latencia medida: 3–10 ms en 1 888 reservas.",
            "bullets": [
                "Teclea <b>Petrova</b> → 7 reservas confirmadas de Nina Petrova de distintos canales.",
                "Teclea <b>103</b> → reservas con código «103» + habitación 103 inspeccionada.",
                "Teclea un número de factura o un email → aparece exacto.",
            ],
            "punch": "Un PMS clásico te obliga a navegar menús anidados. Aquí escribes y aparece.",
            "shot": "02-busqueda-global.png", "mock": mock_search,
        },
        {
            "num": 3, "section": "RESERVAS · LIVE TIMELINE",
            "title": "El rack de habitaciones, pero arrastrable.",
            "lead": "Misma idea que el rack de Opera o Mews, con tooltips ricos al hover, filtros por estado y canal, y drag & drop con confirmación antes de mover.",
            "bullets": [
                "<b>47 habitaciones × 1 803 reservas</b> visibles con filtros.",
                "Filtros por <b>estado</b> y <b>canal</b>; tooltip al hover con huésped y precio.",
                "Drag & drop: arrastrar bloques entre habitaciones, con confirmación.",
            ],
            "punch": "El rack que tu recepcionista quería que tuviese Opera.",
            "shot": "03-live-timeline.png", "mock": mock_timeline,
        },
        {
            "num": 4, "section": "FINANZAS · FOLIOS DIVIDIDOS · DIFERENCIADOR",
            "title": "Split folios reales: huésped, empresa, agencia.",
            "lead": "Estándar en cadenas grandes (Opera, Cloudbeds, Mews), ausente en la mayoría de PMS españoles. Sin esto, no puedes vender a corporate.",
            "bullets": [
                "Dos folios en una reserva: <b>guest (principal)</b> y <b>company (secundario)</b>, cada uno con su balance.",
                "Regla declarativa: «todo cargo de minibar va al folio company» aplicada al postear.",
                "Botón <b>Transferir</b> en cada línea: mover un cargo a otro folio, auditado.",
            ],
            "punch": "Sin esto no puedes vender a empresa. Con esto, sí.",
            "shot": "04-folios.png", "mock": mock_folios,
        },
        {
            "num": 5, "section": "OPERACIONES · TABLERO DE PISOS",
            "title": "Pisos en vivo: limpia, sucia, inspeccionada.",
            "lead": "El tablero de housekeeping en tiempo real. La camarera marca con un tap. La gobernanta ve avance y bloqueos. La recepción sabe qué está vendible.",
            "bullets": [
                "KPIs: <b>17 sucias · 12 limpias · 12 inspeccionadas · 9 tareas abiertas</b>.",
                "Filtros por estado; cada habitación con acciones contextuales.",
                "Conexión directa con disponibilidad y revenue.",
            ],
            "punch": "Reemplaza Quore, hotelkit o el WhatsApp del grupo.",
            "shot": "05-housekeeping.png", "mock": mock_housekeeping,
        },
        {
            "num": 6, "section": "OPERACIONES · MANTENIMIENTO",
            "title": "Avisos, partes y bloqueo de habitación.",
            "lead": "Recepción crea un parte → mantenimiento lo ve en vivo → bloquea la habitación → la habitación deja de ser vendible en availability automáticamente.",
            "bullets": [
                "Priorización: <b>1 emergencia, 5 abiertas, 2 en curso, 3 con habitación bloqueada</b>.",
                "Estados claros, asignación a técnico.",
                "Conexión bidireccional con disponibilidad y revenue.",
            ],
            "punch": "Bloquea aquí, deja de venderse en Booking. Sin intervención humana.",
            "shot": "06-mantenimiento.png", "mock": mock_maintenance,
        },
        {
            "num": 7, "section": "COMPLIANCE · DIFERENCIADOR #1",
            "title": "España resuelta dentro del core.",
            "lead": "~70 controles por área (PMS, RGPD, fiscal, contra incendios, alimentación, PRL). Filtrable por comunidad autónoma y tipo de hotel. Vault con alertas.",
            "bullets": [
                "KPIs: <b>53 % cumplimiento, 3 críticos, 5 vencidos, 9 vencen en 30 d</b>.",
                "Matriz por área (Licencias, Turismo, Registro de viajeros, RGPD, Laboral, PRL…).",
                "Asistente IA + carpeta de inspección imprimible para auditorías.",
            ],
            "punch": "El foso defensivo frente a Cloudbeds y Mews.",
            "shot": "07-compliance.png", "mock": mock_compliance,
        },
        {
            "num": 8, "section": "REVENUE MANAGEMENT",
            "title": "Pace, pickup, forecast, BAR recommendations.",
            "lead": "Revenue de verdad: snapshots reales, MAPE de forecast, recomendaciones BAR, rate shopper, presupuesto vs actual. Sustituye IDeaS o Duetto.",
            "bullets": [
                "<b>OTB 30d 1 078 noches · pace +775 · pickup 7d 945 · forecast 91.54 %</b>.",
                "Ocupación mes <b>73,3 %</b>, ADR <b>137,52 €</b>, RevPAR <b>94,33 €</b>.",
                "Alertas con acción directa: «abrir parrilla de tarifas».",
            ],
            "punch": "Revenue management profesional dentro del PMS, no un add-on de 800 €/mes.",
            "shot": "08-revenue.png", "mock": mock_revenue,
        },
        {
            "num": 9, "section": "DISTRIBUCIÓN · CHANNEL MANAGER",
            "title": "Agregador propio multi-canal.",
            "lead": "Booking, Expedia, Airbnb, Hotelbeds, Vrbo. Empujamos tarifas y disponibilidad, recibimos reservas e identificación. Sustituye SiteMinder.",
            "bullets": [
                "Estado de sincronización por canal; mappings por room type y rate plan.",
                "Health check continuo + alertas de paridad de tarifa.",
                "Modo sandbox para validar credenciales antes de producción.",
            ],
            "punch": "Una capa menos en tu stack — y un partner menos al que pagar comisión.",
            "shot": "09-channel-manager.png", "mock": mock_channel_manager,
        },
        {
            "num": 10, "section": "IA · HITL · DIFERENCIADOR #2",
            "title": "AI-native, no AI-washing.",
            "lead": "Cada salida del modelo (parsear email de reserva, draft de respuesta, OCR de DNI) pasa por revisión humana con score de confianza y fallback determinista.",
            "bullets": [
                "Cola con <b>3 pendientes · 3 fuera de plazo · resolución media 44 min</b>.",
                "Acciones: Asignar, Aprobar, Rechazar, Escalar. Auditadas.",
                "Tipos: rate rec., problema de factura, parte de viajeros…",
            ],
            "punch": "Cero alucinaciones en producción. Cada llamada al modelo es auditable.",
            "shot": "10-hitl.png", "mock": mock_hitl,
        },
        {
            "num": 11, "section": "COMERCIAL · TT.OO.",
            "title": "Cupos contratados con tour operadores.",
            "lead": "Bloques de habitaciones para Hotelbeds, TUI, FTI, JetTours… con release period automático y precio contratado.",
            "bullets": [
                "4 tour operadores configurados con comisión y plazo de pago.",
                "3 cupos activos: 16 habitaciones/día, release a 14–21 días.",
                "Botón <b>Liberar cuotas vencidas</b> devuelve habitaciones al pool general.",
            ],
            "punch": "Si vendes a TT.OO. mayoristas, no puedes vivir sin allotments.",
            "shot": "11-allotments.png", "mock": mock_allotments,
        },
        {
            "num": 12, "section": "F&B · INVENTARIO Y CARTA",
            "title": "Stock, recetas y descuento automático.",
            "lead": "El TPV postea un menú → el motor descuenta los ingredientes según la receta (BOM) → alerta si hay stock bajo. Recetas, mermas, márgenes por plato.",
            "bullets": [
                "9 referencias activas, 6 platos/bebidas, 3 puntos de venta.",
                "Niveles mínimos, stock actual, semáforo de reposición.",
                "Margen medio por plato calculado a partir de la receta.",
            ],
            "punch": "El restaurante deja de ser un agujero negro contable.",
            "shot": "12-fnb-inventory.png", "mock": mock_fnb,
        },
    ]

    # Page layout per scene: top = text+bullets, bottom = mock/screenshot full width
    for sc in scenes:
        story.append(Paragraph(f"ESCENA {sc['num']:02d}  ·  {sc['section']}", S_EYEBROW))
        story.append(Paragraph(sc["title"], S_H2))
        story.append(Paragraph(sc["lead"], S_LEAD))

        # Bullets + punch line in a 2-col table
        bullets_html = "<br/>".join(f"→ {b}" for b in sc["bullets"])
        punch = Paragraph(f"<i>«{sc['punch']}»</i>", S_PUNCH)
        left = [Paragraph(bullets_html, S_BULLET)]
        right = [Paragraph("PUNCH LINE", S_TAG), punch]
        col = Table([[left, right]], colWidths=[170*mm, 75*mm])
        col.setStyle(TableStyle([
            ("VALIGN", (0,0), (-1,-1), "TOP"),
            ("BACKGROUND", (1,0), (1,0), SURFACE),
            ("BOX", (1,0), (1,0), 0.5, BORDER),
            ("LEFTPADDING", (1,0), (1,0), 8),
            ("RIGHTPADDING", (1,0), (1,0), 8),
            ("TOPPADDING", (1,0), (1,0), 6),
            ("BOTTOMPADDING", (1,0), (1,0), 6),
        ]))
        story.append(col)
        story.append(Spacer(1, 4 * mm))

        # Screenshot or mock — large
        shot_path = SHOTS_DIR / sc["shot"]
        story.append(ShotOrMock(shot_path if shot_path.exists() else None, sc["mock"],
                                w=PAGE_W - 2 * MARGIN, h=85 * mm))

        story.append(PageBreak())

    # --- Stack -----------------------------------------------------------------
    story.append(Paragraph("STACK & ESTADO", S_EYEBROW))
    story.append(Paragraph("Real, no maqueta. Construido para escalar.", S_H2))
    story.append(Spacer(1, 4 * mm))

    stack_rows = [
        ["Frontend",        "React 19 + Vite + TypeScript",                              "0 errores typecheck"],
        ["API",             "Fastify + Prisma",                                          "0 errores typecheck"],
        ["Base de datos",   "PostgreSQL 16 con extensión de cifrado PII a nivel columna","1 888 reservas seed"],
        ["IA",              "Providers configurables (Anthropic, OpenAI, Azure)",        "Fallback determinista por defecto"],
        ["Compliance",      "XAdES para parte de viajeros · hash chain VeriFactu",       "Modelos AEAT 303/111/115/180/390"],
        ["Build",           "Monorepo pnpm · CI verde (4 jobs)",                          "Despliegue en minutos"],
    ]
    stack_tbl = Table(
        [["CAPA", "STACK", "ESTADO"]] + stack_rows,
        colWidths=[40*mm, 130*mm, 70*mm],
        rowHeights=[8*mm] + [10*mm]*6,
    )
    stack_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), SURFACE2),
        ("BACKGROUND", (0,1), (-1,-1), SURFACE),
        ("TEXTCOLOR", (0,0), (-1,0), ACCENT),
        ("TEXTCOLOR", (0,1), (-1,-1), INK),
        ("TEXTCOLOR", (2,1), (2,-1), ACCENT),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTNAME", (0,1), (0,-1), "Helvetica-Bold"),
        ("FONTNAME", (2,1), (2,-1), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,0), 8),
        ("FONTSIZE", (0,1), (-1,-1), 10),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("LEFTPADDING", (0,0), (-1,-1), 8),
        ("LINEBELOW", (0,0), (-1,0), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [SURFACE, SURFACE2]),
    ]))
    story.append(stack_tbl)

    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph("DIFERENCIADORES FRENTE A CLOUDBEDS / MEWS", S_EYEBROW))
    diff_rows = [
        ("Cumplimiento español en el core", "SES Hospedajes, parte de viajeros XAdES, modelos AEAT, normativa por CCAA. No es un add-on."),
        ("AI-native con Human-in-the-Loop", "Cada salida del modelo pasa por revisión opcional con score de confianza y fallback determinista."),
        ("Folios divididos reales", "Split entre huésped/empresa/agencia con reglas declarativas. Imprescindible para corporate."),
        ("Mobile-first", "Pensado para recepción con tablet/móvil, dark mode, responsive desde el día cero."),
        ("API-first", "Fastify + Prisma. Todos los datos consultables vía API, todos los eventos auditados."),
    ]
    for title, desc in diff_rows:
        story.append(Paragraph(f"<b>{title}.</b> {desc}", S_BODY))
    story.append(PageBreak())

    # --- Closing / CTA -------------------------------------------------------
    story.append(Spacer(1, 50 * mm))
    story.append(Paragraph("PRÓXIMOS PASOS", S_EYEBROW))
    story.append(Paragraph("Hablamos del piloto.", S_H1))
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph(
        "<b>1.  Demo en vivo</b> con el equipo del socio (60 min, screen share).<br/>"
        "<b>2.  Acceso al entorno de pruebas</b> para que el socio explore solo.<br/>"
        "<b>3.  Diseño conjunto del piloto:</b> 1–3 hoteles del entorno del socio, 90 días, sin coste de licencia.",
        S_LEAD,
    ))
    story.append(Spacer(1, 20 * mm))
    story.append(Hr(color=ACCENT, thickness=1.5))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph("Carlos Fernández — Founder", S_H3))
    story.append(Paragraph(
        "<b>Email:</b>  [tu email]<br/>"
        "<b>Tel.:</b>   [tu teléfono]<br/>"
        "<b>Web:</b>    [tu URL]<br/>"
        "<b>Ubicación:</b>  Madrid, España",
        S_BODY_MUTE,
    ))

    # ---------------------------------------------------------------------
    # Build
    doc.build(story, onFirstPage=draw_cover_background, onLaterPages=draw_dark_background)
    print(f"OK: {OUT_PDF} ({OUT_PDF.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    build()
