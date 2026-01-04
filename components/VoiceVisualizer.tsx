
import React, { useEffect, useRef } from 'react';

interface VoiceVisualizerProps {
  isActive: boolean;
  isSpeaking: boolean;
}

const VoiceVisualizer: React.FC<VoiceVisualizerProps> = ({ isActive, isSpeaking }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let offset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = 60;
      
      ctx.beginPath();
      ctx.strokeStyle = isSpeaking ? '#fbbf24' : isActive ? '#60a5fa' : '#4b5563';
      ctx.lineWidth = 3;

      for (let i = 0; i < 360; i++) {
        const angle = (i * Math.PI) / 180;
        const amplitude = (isSpeaking || isActive) ? Math.sin(angle * 8 + offset) * 5 : 0;
        const x = centerX + (radius + amplitude) * Math.cos(angle);
        const y = centerY + (radius + amplitude) * Math.sin(angle);
        
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      
      ctx.closePath();
      ctx.stroke();

      offset += 0.1;
      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [isActive, isSpeaking]);

  return (
    <div className="relative flex items-center justify-center h-64 w-64 mx-auto">
      <div className={`absolute inset-0 rounded-full bg-gradient-to-tr from-yellow-900/20 to-blue-900/20 blur-2xl transition-opacity duration-1000 ${isActive ? 'opacity-100' : 'opacity-0'}`} />
      <canvas 
        ref={canvasRef} 
        width={300} 
        height={300} 
        className="relative z-10 w-full h-full"
      />
      <div className={`absolute w-32 h-32 rounded-full glass-panel flex items-center justify-center transition-all duration-500 ${isSpeaking ? 'scale-110 border-yellow-500/50' : 'scale-100'}`}>
         <div className={`w-16 h-16 rounded-full ${isSpeaking ? 'bg-yellow-600' : isActive ? 'bg-blue-600' : 'bg-gray-700'} transition-colors duration-300 shadow-xl`} />
      </div>
    </div>
  );
};

export default VoiceVisualizer;
