import { useEffect, useState } from "react";
import "./App.css";

function App() {
  const [trailData, setTrailData] = useState([]);

  useEffect(() => {
    const evtSource = new EventSource("http://localhost:3000/stream");
    evtSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setTrailData(data);
    };
    return () => evtSource.close();
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <h1 className="text-2xl font-bold mb-4">📈 Live SL Trail Monitor</h1>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {trailData.map((item) => (
          <div key={item.symbol} className="bg-white shadow p-4 rounded-2xl border border-gray-200">
            <h2 className="font-semibold text-lg mb-2">{item.symbol}</h2>
            <p>📌 Entry: ₹{item.entryPrice}</p>
            <p>📉 SL Trigger: ₹{item.currentSL}</p>
            <p>🚀 Price: ₹{item.currentPrice}</p>
            <p>🔁 Steps Trailed: {item.trailStepCount}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
