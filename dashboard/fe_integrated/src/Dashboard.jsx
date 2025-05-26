import { useEffect, useState } from "react";
import io from "socket.io-client";

const socket = io("http://localhost:3001"); // replace with your backend

function Dashboard() {
  const [pnl, setPnl] = useState(0);
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    socket.on("pnlUpdate", (data) => {
      setPnl(data.totalPnl);
      setPositions(data.positions);
    });

    return () => {
      socket.off("pnlUpdate");
    };
  }, []);

  const handleSquareOff = () => {
    socket.emit("squareOffAll");
  };

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-4">📊 Nifty Options Dashboard</h1>

        <div
          className={`p-6 rounded-xl shadow-md mb-6 ${
            pnl >= 0 ? "bg-green-100" : "bg-red-100"
          }`}
        >
          <h2 className="text-xl font-semibold">Total P&L</h2>
          <p className="text-4xl font-bold">{pnl.toFixed(2)} ₹</p>
        </div>

        <div className="bg-white rounded-xl shadow-md p-6 mb-6">
          <h2 className="text-xl font-semibold mb-2">Open Positions</h2>
          {positions.length === 0 ? (
            <p className="text-gray-500">No open positions.</p>
          ) : (
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b">
                  <th className="py-2">Symbol</th>
                  <th>Qty</th>
                  <th>Avg Price</th>
                  <th>LTP</th>
                  <th>P&L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => (
                  <tr key={pos.symbol} className="border-b">
                    <td className="py-2">{pos.symbol}</td>
                    <td>{pos.qty}</td>
                    <td>{pos.avgPrice}</td>
                    <td>{pos.ltp}</td>
                    <td
                      className={`${
                        pos.pnl >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {pos.pnl.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <button
          onClick={handleSquareOff}
          className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition duration-200"
        >
          🛑 Square Off All
        </button>
      </div>
    </div>
  );
}

export default Dashboard;
