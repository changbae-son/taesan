"""
키움 OpenAPI+ → Firebase 동기화 서버
웹앱에서 "키움 데이터 받기" 버튼 클릭 시 localhost:5000/sync 호출
"""

import json
import time
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

# Firebase Admin SDK
import firebase_admin
from firebase_admin import credentials, firestore

# 키움 OpenAPI+
from pykiwoom.kiwoom import Kiwoom

# ─── Firebase 초기화 ───
FIREBASE_CONFIG = {
    "type": "service_account",
    "project_id": "teasan-f4c17",
}

# Firebase 초기화 (서비스 계정 키 파일 사용)
SERVICE_ACCOUNT_PATH = "firebase-service-account.json"

try:
    cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("[OK] Firebase 연결 성공")
except Exception as e:
    print(f"[ERROR] Firebase 연결 실패: {e}")
    print(f"  → {SERVICE_ACCOUNT_PATH} 파일이 필요합니다.")
    print(f"  → Firebase 콘솔 > 설정 > 서비스 계정 > 새 비공개 키 생성")
    sys.exit(1)

# ─── 키움 API 초기화 ───
kiwoom = None
kiwoom_connected = False


def connect_kiwoom():
    """키움 OpenAPI+ 로그인"""
    global kiwoom, kiwoom_connected
    try:
        kiwoom = Kiwoom()
        kiwoom.CommConnect(block=True)
        kiwoom_connected = True
        print("[OK] 키움 OpenAPI+ 로그인 성공")
    except Exception as e:
        print(f"[ERROR] 키움 연결 실패: {e}")
        print("  → 키움증권 OpenAPI+가 설치되어 있어야 합니다.")
        print("  → 32bit Python이 필요합니다.")
        kiwoom_connected = False


def get_account_info():
    """계좌 정보 조회"""
    if not kiwoom_connected:
        return None, None
    accounts = kiwoom.GetLoginInfo("ACCNO")
    account = accounts.split(";")[0].strip()
    return account, kiwoom.GetLoginInfo("USER_NAME")


def fetch_holdings(account):
    """보유 종목 잔고 조회 (opw00018)"""
    if not kiwoom_connected:
        return []

    kiwoom.SetInputValue("계좌번호", account)
    kiwoom.SetInputValue("비밀번호", "")
    kiwoom.SetInputValue("비밀번호입력매체구분", "00")
    kiwoom.SetInputValue("조회구분", "1")
    kiwoom.CommRqData("계좌평가잔고내역요청", "opw00018", 0, "0101")

    time.sleep(0.5)

    holdings = []
    count = kiwoom.GetRepeatCnt("계좌평가잔고내역요청", "계좌평가잔고내역요청")

    for i in range(count):
        name = kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역요청", i, "종목명").strip()
        code = kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역요청", i, "종목번호").strip()
        quantity = abs(int(kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역요청", i, "보유수량").strip()))
        avg_price = abs(int(kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역요청", i, "매입가").strip()))
        current_price = abs(int(kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역요청", i, "현재가").strip()))
        profit_rate = float(kiwoom.GetCommData("계좌평가잔고내역요청", "계좌평가잔고내역요청", i, "수익률(%)").strip())

        holdings.append({
            "name": name,
            "code": code.replace("A", ""),
            "quantity": quantity,
            "avgPrice": avg_price,
            "currentPrice": current_price,
            "profitRate": profit_rate,
        })

    return holdings


def fetch_trade_history(account, start_date=None, end_date=None):
    """체결 내역 조회 (opw00007)"""
    if not kiwoom_connected:
        return []

    if not start_date:
        start_date = datetime.now().strftime("%Y%m%d")
    if not end_date:
        end_date = datetime.now().strftime("%Y%m%d")

    kiwoom.SetInputValue("주문일자", start_date)
    kiwoom.SetInputValue("계좌번호", account)
    kiwoom.SetInputValue("비밀번호", "")
    kiwoom.SetInputValue("비밀번호입력매체구분", "00")
    kiwoom.SetInputValue("조회구분", "0")
    kiwoom.SetInputValue("주식채권구분", "0")
    kiwoom.SetInputValue("매도수구분", "0")
    kiwoom.CommRqData("계좌별주문체결내역상세요청", "opw00007", 0, "0102")

    time.sleep(0.5)

    trades = []
    count = kiwoom.GetRepeatCnt("계좌별주문체결내역상세요청", "계좌별주문체결내역상세요청")

    for i in range(count):
        name = kiwoom.GetCommData("계좌별주문체결내역상세요청", "계좌별주문체결내역상세요청", i, "종목명").strip()
        trade_type = kiwoom.GetCommData("계좌별주문체결내역상세요청", "계좌별주문체결내역상세요청", i, "매매구분").strip()
        price = abs(int(kiwoom.GetCommData("계좌별주문체결내역상세요청", "계좌별주문체결내역상세요청", i, "체결가격").strip() or "0"))
        quantity = abs(int(kiwoom.GetCommData("계좌별주문체결내역상세요청", "계좌별주문체결내역상세요청", i, "체결수량").strip() or "0"))
        trade_date = kiwoom.GetCommData("계좌별주문체결내역상세요청", "계좌별주문체결내역상세요청", i, "주문일자").strip()
        trade_time = kiwoom.GetCommData("계좌별주문체결내역상세요청", "계좌별주문체결내역상세요청", i, "체결시간").strip()

        if price > 0 and quantity > 0:
            trades.append({
                "name": name,
                "type": "buy" if "매수" in trade_type else "sell",
                "price": price,
                "quantity": quantity,
                "date": trade_date,
                "time": trade_time,
            })

    return trades


def sync_to_firebase(holdings, trades_data):
    """Firebase Firestore에 동기화"""
    now = int(time.time() * 1000)
    synced_stocks = 0
    synced_trades = 0

    # 기존 종목 목록 조회
    existing_stocks = {}
    docs = db.collection("stocks").stream()
    for doc in docs:
        data = doc.to_dict()
        existing_stocks[data.get("name", "")] = doc.id

    # 보유 종목 동기화
    for h in holdings:
        stock_name = h["name"]

        if stock_name in existing_stocks:
            # 기존 종목 업데이트 (현재가, 보유수량, 평단가)
            doc_id = existing_stocks[stock_name]
            db.collection("stocks").document(doc_id).update({
                "currentPrice": h["currentPrice"],
                "avgPrice": h["avgPrice"],
                "totalQuantity": h["quantity"],
                "updatedAt": now,
            })
        else:
            # 새 종목 추가
            doc_id = f"stock_{now}_{synced_stocks}"
            buy_plans = []
            for i in range(5):
                bp = {
                    "level": i + 1,
                    "price": h["avgPrice"] if i == 0 else 0,
                    "quantity": h["quantity"] if i == 0 else 0,
                    "filled": i == 0,
                }
                buy_plans.append(bp)

            sell_plans = []
            for p in [5, 10, 15, 20, 25]:
                sell_plans.append({
                    "percent": p,
                    "price": round(h["avgPrice"] * (1 + p / 100)) if h["avgPrice"] > 0 else 0,
                    "quantity": round(h["quantity"] * 0.2),
                    "filled": False,
                })

            ma_sells = []
            for ma in [20, 60, 120]:
                ma_sells.append({"ma": ma, "price": 0, "quantity": 0, "filled": False})

            db.collection("stocks").document(doc_id).set({
                "name": stock_name,
                "rule": "A",
                "firstBuyPrice": h["avgPrice"],
                "firstBuyQuantity": h["quantity"],
                "currentPrice": h["currentPrice"],
                "avgPrice": h["avgPrice"],
                "totalQuantity": h["quantity"],
                "buyPlans": buy_plans,
                "sellPlans": sell_plans,
                "maSells": ma_sells,
                "sellCount": 0,
                "createdAt": now,
                "updatedAt": now,
            })

        synced_stocks += 1

    # 체결 내역 → 매매 일지에 추가
    for t in trades_data:
        trade_id = f"trade_kiwoom_{t['date']}_{t['time']}_{t['name']}"
        trade_date_formatted = f"{t['date'][:4]}-{t['date'][4:6]}-{t['date'][6:8]}"

        # 이미 존재하는지 확인
        doc_ref = db.collection("trades").document(trade_id)
        if not doc_ref.get().exists:
            doc_ref.set({
                "date": trade_date_formatted,
                "stockName": t["name"],
                "type": t["type"],
                "price": t["price"],
                "quantity": t["quantity"],
                "memo": f"키움 자동동기화 ({t.get('time', '')})",
                "tags": ["#키움동기화"],
                "createdAt": now,
            })
            synced_trades += 1

    return synced_stocks, synced_trades


# ─── HTTP 서버 ───
class SyncHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        """CORS preflight"""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        """상태 확인 및 동기화"""
        self.send_header_cors()

        if self.path == "/status":
            self.send_json({
                "connected": kiwoom_connected,
                "timestamp": datetime.now().isoformat(),
            })

        elif self.path.startswith("/sync"):
            if not kiwoom_connected:
                self.send_json({"error": "키움 API 미연결"}, status=503)
                return

            try:
                account, user_name = get_account_info()
                holdings = fetch_holdings(account)
                trades_data = fetch_trade_history(account)
                synced_stocks, synced_trades = sync_to_firebase(holdings, trades_data)

                self.send_json({
                    "success": True,
                    "account": account,
                    "user": user_name,
                    "syncedStocks": synced_stocks,
                    "syncedTrades": synced_trades,
                    "holdings": len(holdings),
                    "timestamp": datetime.now().isoformat(),
                })
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)

        elif self.path == "/holdings":
            if not kiwoom_connected:
                self.send_json({"error": "키움 API 미연결"}, status=503)
                return
            account, _ = get_account_info()
            holdings = fetch_holdings(account)
            self.send_json({"holdings": holdings})

        else:
            self.send_json({"message": "키움 동기화 서버 실행 중", "endpoints": ["/status", "/sync", "/holdings"]})

    def send_header_cors(self):
        pass

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def log_message(self, format, *args):
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {args[0]}")


def main():
    PORT = 5000
    print("=" * 50)
    print("  태산매매법 - 키움 동기화 서버")
    print("=" * 50)

    # 키움 연결
    print("\n[1/2] 키움 OpenAPI+ 로그인 중...")
    connect_kiwoom()

    if kiwoom_connected:
        account, user_name = get_account_info()
        print(f"  → 계좌: {account}, 사용자: {user_name}")

    # HTTP 서버 시작
    print(f"\n[2/2] 동기화 서버 시작 (http://localhost:{PORT})")
    print(f"  → 웹앱에서 '키움 데이터 받기' 버튼을 클릭하세요")
    print(f"  → 종료: Ctrl+C\n")

    server = HTTPServer(("localhost", PORT), SyncHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버 종료")
        server.server_close()


if __name__ == "__main__":
    main()
